import { getPartnerDocByRef } from "@/server/partners/firestore";
import { getRestrictedFinancialIdentityDoc } from "@/server/shared/restricted-financial-identity";
import { getVendorDocByRef } from "@/server/vendors/firestore";

import { computePayeeIdentityMatch, type PayeeIdentityEvidence } from "./matcher";
import type { PayeeIdentityMatchResult } from "./types";

// Step 16C section 3/4/20: resolves the CANONICAL counterparty identity from the Payable-pinned
// counterparty ONLY - a single by-ref document lookup (getPartnerDocByRef / getVendorDocByRef,
// exactly the same read the existing finance-invoices-gate.ts already performs for Record Scope),
// never a query across all Partners/Vendors and never a name-similarity search. There is no
// parameter here through which a caller could substitute a different entity.
//
// This is the ONLY file in the payee-identity module that reads Firestore / the restricted
// financial-identity collection. It is intentionally NOT exported from this module's index barrel:
// it is called exclusively by invoice-service.ts / invoice-lifecycle-service.ts, the same trusted
// server layer that already resolves the Payable pin, never directly by a route.
//
// RESTRICTED READ (section 5): `getRestrictedFinancialIdentityDoc` is a server-only accessor over
// the shared, cross-domain restrictedFinancialIdentities collection (the same one Partners'/
// Vendors' own restricted-identity-service.ts uses to let an authorized operator VIEW/EDIT those
// values). Reading it here is a different, narrower thing: it is a trusted-server-internal
// computation that NEVER returns the raw value to any caller - only a masked/status projection
// (matcher.ts's safe-display builders). The actual authorization surface a browser can reach is the
// Invoice's own finance_amounts-gated read (requireAuthoringAccess), which already gates every
// caller of this function.

export type ResolvePayeeIdentityInput = {
  counterpartyType: "PARTNER" | "VENDOR";
  counterpartyRef: string;
  // The Invoice's own extracted/declared payee evidence (ordinary, non-restricted - see
  // extraction/field-extractors.ts's supplierNameField). Address/bank/tax extraction do not exist
  // yet in this codebase (no OCR, no restricted extraction pipeline) - see the null literals below.
  extractedPayeeName: string | null;
};

export async function resolveAndComparePayeeIdentity(input: ResolvePayeeIdentityInput): Promise<PayeeIdentityMatchResult> {
  let expectedName: string | null = null;
  let subjectUid: string | null = null;

  if (input.counterpartyType === "VENDOR") {
    const vendor = await getVendorDocByRef(input.counterpartyRef);
    expectedName = vendor?.legalName ?? vendor?.displayName ?? null;
    subjectUid = vendor?.uid ?? null;
  } else {
    const partner = await getPartnerDocByRef(input.counterpartyRef);
    expectedName = partner?.legalName ?? partner?.displayName ?? null;
    subjectUid = partner?.uid ?? null;
  }

  const restricted = subjectUid ? await getRestrictedFinancialIdentityDoc(input.counterpartyType, subjectUid) : null;
  const expectedTaxId = restricted?.gst?.applicable ? (restricted.gst.number ?? null) : null;
  const expectedBankIdentifier = restricted?.bank?.accountNumber ?? null;

  const evidence: PayeeIdentityEvidence = {
    expectedName,
    extractedName: input.extractedPayeeName,
    expectedTaxId,
    // Step 16C: the raw tax-registration value is never surfaced out of Invoice extraction (see
    // extraction/field-extractors.ts's gstinField - `value` is withheld as null by design; there is
    // no restricted-extraction pipeline in this step and no OCR). The comparator above fully
    // supports this field end to end (see matcher.test.ts / normalization.test.ts); only this live
    // data path cannot populate the extracted side yet, so it always reports UNAVAILABLE today.
    extractedTaxId: null,
    // No canonical "billing/business address" field exists on Partner or Vendor today (see
    // src/server/partners/types.ts / src/server/vendors/types.ts) and no address extraction exists
    // (section 6: "do not invent identity values") - both sides are always UNAVAILABLE today.
    expectedAddress: null,
    extractedAddress: null,
    expectedBankIdentifier,
    // No bank-identifier extraction exists in this step (no OCR) - always UNAVAILABLE today.
    extractedBankIdentifier: null,
  };

  return computePayeeIdentityMatch(evidence);
}
