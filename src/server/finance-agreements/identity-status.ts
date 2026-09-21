import { getAdminFirestore } from "@/server/firebase/admin";
import {
  getRestrictedFinancialIdentityDoc,
  restrictedFinancialIdentitiesCollection,
  restrictedFinancialIdentityDocSchema,
  restrictedIdentityDocId,
  type RestrictedFinancialIdentityDoc,
} from "@/server/shared/restricted-financial-identity";

import { deriveIdentityStatusState } from "./fields";
import type { IdentityComponentStatus } from "./terms";
import type { CounterpartyType, IdentityComponents, IdentityStatusSnapshot } from "./types";

// Step 14A: identity STATUS for an Agreement counterparty - component PRESENCE only.
//
// The canonical restricted store (restrictedFinancialIdentities, read through its own shared
// boundary module) is the ONLY home of PAN / Aadhaar / GST / bank values. This helper reads
// that one document server-side and reduces it to four presence flags; NO value, holder name,
// bank name or evidence link is ever copied out of it, and none can reach a return value.
// Finance therefore stores no duplicate identity data, and the reconciliation service reuses
// this exact function so both compute status the same way.

// Pure. `doc` null = nothing recorded yet. A component is:
//   PRESENT         the canonical value is on file
//   INCOMPLETE      the canonical value is absent BUT an evidence document of that type is on file ("document on file, details
//                   not entered"); for GST also: GST applies but no number is on file
//   MISSING         nothing on file
//   NOT_APPLICABLE  Aadhaar for a Vendor; GST recorded as not applicable
// Only the evidence TYPE is consulted (never its link / file name), so no value or evidence detail can reach the result.
//   pan      doc.pan                          -> PRESENT; else an evidence "pan" -> INCOMPLETE; else MISSING
//   aadhaar  Partner only; same rule with "aadhaar"; a Vendor has none (NOT_APPLICABLE)
//   gst      applicable:false -> NOT_APPLICABLE; applicable with a number -> PRESENT; applicable without a number -> INCOMPLETE;
//            no gst record -> an evidence "gst" -> INCOMPLETE, else MISSING
//   bank     doc.bank -> PRESENT; else an evidence "bank" -> INCOMPLETE; else MISSING (a partial bank record cannot be stored)
export function deriveIdentityComponents(counterpartyType: CounterpartyType, doc: RestrictedFinancialIdentityDoc | null): IdentityComponents {
  const evidence = new Set((doc?.evidence ?? []).map((item) => item.docType));
  const absent = (docType: "pan" | "aadhaar" | "gst" | "bank"): IdentityComponentStatus => (evidence.has(docType) ? "INCOMPLETE" : "MISSING");
  return {
    pan: doc?.pan ? "PRESENT" : absent("pan"),
    aadhaar: counterpartyType === "VENDOR" ? "NOT_APPLICABLE" : doc?.aadhaar ? "PRESENT" : absent("aadhaar"),
    gst: doc?.gst ? (doc.gst.applicable ? (doc.gst.number ? "PRESENT" : "INCOMPLETE") : "NOT_APPLICABLE") : absent("gst"),
    bank: doc?.bank ? "PRESENT" : absent("bank"),
  };
}

// Pure. The status snapshot for already-known components (state per deriveIdentityStatusState).
export function buildIdentityStatusSnapshot(counterpartyType: CounterpartyType, doc: RestrictedFinancialIdentityDoc | null, capturedAt: string): IdentityStatusSnapshot {
  const components = deriveIdentityComponents(counterpartyType, doc);
  return { state: deriveIdentityStatusState(components), components, capturedAt };
}

// Reads the canonical restricted subject document (keyed by the Partner's / Vendor's own uid)
// and returns STATUS ONLY. If the store cannot be read the state is UNAVAILABLE (components
// are then reported MISSING, never guessed as present): an unreadable store must never make an
// Agreement look KYC-complete. `now` is injectable for tests.
export async function computeIdentityStatus(counterpartyType: CounterpartyType, subjectUid: string, now: () => string = () => new Date().toISOString()): Promise<IdentityStatusSnapshot> {
  const capturedAt = now();
  try {
    const doc = await getRestrictedFinancialIdentityDoc(counterpartyType, subjectUid);
    return buildIdentityStatusSnapshot(counterpartyType, doc, capturedAt);
  } catch {
    return { state: "UNAVAILABLE", components: deriveIdentityComponents(counterpartyType, null), capturedAt };
  }
}

// Step 14B: the SAME status for a bounded PAGE of subjects with ONE Firestore round trip (`getAll`) instead of one read per
// row. Same reduction as computeIdentityStatus (presence flags only - no value ever leaves this function), same fail-closed
// rule: if the store cannot be read every subject is UNAVAILABLE, never guessed as present. Keyed by `${type}:${uid}`.
export const MAX_BULK_IDENTITY_SUBJECTS = 100;

export async function computeIdentityStatusBulk(subjects: ReadonlyArray<{ type: CounterpartyType; uid: string }>, now: () => string = () => new Date().toISOString()): Promise<Map<string, IdentityStatusSnapshot>> {
  const capturedAt = now();
  const unique = [...new Map(subjects.slice(0, MAX_BULK_IDENTITY_SUBJECTS).map((subject) => [restrictedIdentityDocId(subject.type, subject.uid), subject] as const)).entries()];
  const result = new Map<string, IdentityStatusSnapshot>();
  if (unique.length === 0) return result;
  try {
    const snapshots = await getAdminFirestore().getAll(...unique.map(([key]) => restrictedFinancialIdentitiesCollection().doc(key)));
    snapshots.forEach((snapshot, index) => {
      const [key, subject] = unique[index]!;
      const parsed = snapshot.exists ? restrictedFinancialIdentityDocSchema.safeParse(snapshot.data()) : null;
      result.set(key, buildIdentityStatusSnapshot(subject.type, parsed?.success ? parsed.data : null, capturedAt));
    });
  } catch {
    for (const [key, subject] of unique) result.set(key, { state: "UNAVAILABLE", components: deriveIdentityComponents(subject.type, null), capturedAt });
  }
  return result;
}
