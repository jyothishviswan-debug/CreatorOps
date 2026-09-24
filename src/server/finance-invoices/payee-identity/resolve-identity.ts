import { getPartnerDocByRef } from "@/server/partners/firestore";
import { getRestrictedFinancialIdentityDoc } from "@/server/shared/restricted-financial-identity";
import { getVendorDocByRef } from "@/server/vendors/firestore";

import { computePayeeIdentityMatch } from "./matcher";
import { buildPayeeIdentityEvidence, type RestrictedPayeeIdentityEvidence } from "./restricted-extraction";
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
  // extraction/field-extractors.ts's supplierNameField).
  extractedPayeeName: string | null;
  // Step 16D: already-extracted RESTRICTED evidence (GSTIN/address/bank) for the EXACT document
  // bytes this Invoice version pins - computed synchronously by the caller, immediately before this
  // call, from pdf-text.ts + restricted-extraction.ts (see invoice-service.ts's
  // attachInvoiceDocument/reviseInvoiceDraft). Never sourced from a client request, never persisted
  // anywhere raw - this function folds it into the safe comparison result below and then it is
  // discarded. `null`/omitted when no document is attached yet, its text could not be read (section
  // 9: no OCR - INSUFFICIENT_EVIDENCE, matching Step 16C's existing behaviour), or the caller has
  // not (yet) recomputed it (e.g. a Draft with a document already attached, revised for a reason
  // unrelated to identity - see reviseInvoiceDraft, which always re-derives this from the currently
  // attached document rather than omitting it).
  restrictedEvidence?: RestrictedPayeeIdentityEvidence | null;
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
  // Step 16D section 3/10: the one canonical registered/billing address (see
  // src/server/shared/restricted-financial-identity.ts) - null when the subject has none on file.
  const expectedAddress = restricted?.address ?? null;

  const evidence = buildPayeeIdentityEvidence({ expectedName, expectedTaxId, expectedAddress, expectedBankIdentifier }, input.extractedPayeeName, input.restrictedEvidence ?? null);

  return computePayeeIdentityMatch(evidence);
}
