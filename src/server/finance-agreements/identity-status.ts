import { getRestrictedFinancialIdentityDoc, type RestrictedFinancialIdentityDoc } from "@/server/shared/restricted-financial-identity";

import { deriveIdentityStatusState } from "./fields";
import type { CounterpartyType, IdentityComponents, IdentityStatusSnapshot } from "./types";

// Step 14A: identity STATUS for an Agreement counterparty - component PRESENCE only.
//
// The canonical restricted store (restrictedFinancialIdentities, read through its own shared
// boundary module) is the ONLY home of PAN / Aadhaar / GST / bank values. This helper reads
// that one document server-side and reduces it to four presence flags; NO value, holder name,
// bank name or evidence link is ever copied out of it, and none can reach a return value.
// Finance therefore stores no duplicate identity data, and the reconciliation service reuses
// this exact function so both compute status the same way.

// Pure. `doc` null = nothing recorded yet.
//   pan      PRESENT when a PAN number is on file, else MISSING
//   aadhaar  Partner only: PRESENT when on file, else MISSING; a Vendor has none (NOT_APPLICABLE)
//   gst      applicable:false -> NOT_APPLICABLE; applicable with a number -> PRESENT; else MISSING
//   bank     PRESENT when the record holds a bank account, else MISSING
export function deriveIdentityComponents(counterpartyType: CounterpartyType, doc: RestrictedFinancialIdentityDoc | null): IdentityComponents {
  return {
    pan: doc?.pan ? "PRESENT" : "MISSING",
    aadhaar: counterpartyType === "VENDOR" ? "NOT_APPLICABLE" : doc?.aadhaar ? "PRESENT" : "MISSING",
    gst: doc?.gst ? (doc.gst.applicable ? (doc.gst.number ? "PRESENT" : "MISSING") : "NOT_APPLICABLE") : "MISSING",
    bank: doc?.bank ? "PRESENT" : "MISSING",
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
