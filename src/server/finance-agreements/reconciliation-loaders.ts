import { getPartnerAccountDocsByRefs, getPartnerDocByRef, listPartnerAccountDocs } from "@/server/partners/firestore";
import type { PartnerAccountDoc, PartnerDoc } from "@/server/partners/types";
import { getRestrictedFinancialIdentityDoc } from "@/server/shared/restricted-financial-identity";
import { getVendorDocByRef } from "@/server/vendors/firestore";
import type { VendorDoc } from "@/server/vendors/types";

import type { AgreementFieldKey } from "./fields";
import { financeAgreementExtractionRunsCollection, getRestrictedExtractionDoc } from "./firestore";
import type { CanonicalSnapshot } from "./reconciliation-compare";
import { extractionRunDocSchema, type AgreementHeadDoc, type AgreementVersionDoc, type CounterpartyType, type RestrictedExtractionDoc } from "./types";

// Step 14A: the READ-ONLY loaders the reconciliation, KYC-status and master-data services share.
// Nothing here writes, and nothing here decides authorization: every caller has already passed the
// Agreement gate (finance feature + live Record Scope) and, where these read restricted stores, the
// identity / finance_contracts checks.

export type LoadedCounterpartyDoc = { type: "PARTNER"; partner: PartnerDoc } | { type: "VENDOR"; vendor: VendorDoc };

// The LIVE Partner / Vendor the head names (the caller has already verified its scope; the uid
// check here re-confirms the head still points at the same record).
export async function loadCounterpartyDoc(head: AgreementHeadDoc): Promise<LoadedCounterpartyDoc | null> {
  if (head.counterparty.type === "VENDOR") {
    const vendor = await getVendorDocByRef(head.counterparty.vendorRef);
    return vendor && vendor.uid === head.vendorUid ? { type: "VENDOR", vendor } : null;
  }
  const partner = await getPartnerDocByRef(head.counterparty.partnerRef);
  return partner && partner.uid === head.partnerUid ? { type: "PARTNER", partner } : null;
}

// The Partner Accounts a Partner Agreement version is about: the ones the version names, else all
// of the Partner's own (bounded). A ref that belongs to another Partner is ignored.
export async function loadAgreementAccounts(version: AgreementVersionDoc, partner: PartnerDoc): Promise<PartnerAccountDoc[]> {
  if (version.counterparty.type !== "PARTNER") return [];
  const refs = version.counterparty.partnerAccountRefs;
  if (refs.length === 0) return listPartnerAccountDocs(partner.partnerRef);
  const found = await getPartnerAccountDocsByRefs(refs);
  return refs.map((ref) => found.get(ref)).filter((account): account is PartnerAccountDoc => Boolean(account) && account!.partnerRef === partner.partnerRef);
}

export type LoadedIdentity = CanonicalSnapshot["identity"];

// The canonical restricted store, reduced to what the comparison needs. Fails to "unreadable",
// never to "empty": an unreadable store must not be reported as a store with nothing in it.
export async function loadCanonicalIdentity(type: CounterpartyType, subjectUid: string): Promise<Exclude<LoadedIdentity, null>> {
  try {
    const doc = await getRestrictedFinancialIdentityDoc(type, subjectUid);
    return {
      pan: doc?.pan?.number ?? null,
      aadhaar: type === "PARTNER" ? (doc?.aadhaar?.number ?? null) : null,
      gst: doc?.gst ? { applicable: doc.gst.applicable, number: doc.gst.number ?? null } : null,
      bankAccountNo: doc?.bank?.accountNumber ?? null,
      bankIfscCode: doc?.bank?.ifsc ?? null,
    };
  } catch {
    return "unreadable";
  }
}

// The run a version's restricted values come from: the run attached to the version, else (reads
// only) the Agreement's newest run. The newest run is a single-field orderBy on createdAt - served
// by the automatic index, no composite. Never used to WRITE anything unless it was attached.
export async function resolveExtractionRunRef(version: AgreementVersionDoc, options: { attachedOnly: boolean }): Promise<string | null> {
  if (version.source.extractionRunRef) return version.source.extractionRunRef;
  if (options.attachedOnly) return null;
  const snapshot = await financeAgreementExtractionRunsCollection(version.agreementRef).orderBy("createdAt", "desc").limit(1).get();
  const doc = snapshot.docs[0];
  if (!doc) return null;
  const parsed = extractionRunDocSchema.safeParse(doc.data());
  return parsed.success ? parsed.data.runRef : null;
}

// SERVER-ONLY. Callers must already have passed requireContractSensitiveAccess AND the counterparty's
// identity category. The restricted doc must belong to THIS Agreement.
export async function loadRestrictedExtraction(version: AgreementVersionDoc, options: { attachedOnly: boolean }): Promise<{ runRef: string; doc: RestrictedExtractionDoc } | null> {
  const runRef = await resolveExtractionRunRef(version, options);
  if (!runRef) return null;
  const doc = await getRestrictedExtractionDoc(runRef);
  if (!doc || doc.agreementRef !== version.agreementRef) return null;
  return { runRef, doc };
}

const IDENTITY_EXTRACTED_KEYS: readonly AgreementFieldKey[] = ["gstin", "aadhaarNumber", "panNumber", "panHolderName", "bankAccountNumber", "ifsc"];

// The restricted extracted values of the identity fields, by field key (empty rawValue omitted).
export function restrictedIdentityValues(doc: RestrictedExtractionDoc | null): Partial<Record<AgreementFieldKey, string>> {
  const out: Partial<Record<AgreementFieldKey, string>> = {};
  if (!doc) return out;
  for (const key of IDENTITY_EXTRACTED_KEYS) {
    const raw = doc.fields[key]?.rawValue;
    if (typeof raw === "string" && raw.trim().length > 0) out[key] = raw.trim();
  }
  return out;
}
