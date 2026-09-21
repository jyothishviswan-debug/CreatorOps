import { z } from "zod";

import { canPerformAction } from "@/server/authz/capabilities";
import type { ActorContext } from "@/server/authz/types";
import { requirePartnersAccess } from "@/server/partners/partners-gate";
import { normalizePlatformIdentifier } from "@/server/shared/platform";
import { requireVendorsAccess } from "@/server/vendors/vendors-gate";

import { reconciliationEntriesForVersion } from "./agreement-draft";
import { requireContractSensitiveAccess, requireIdentitySensitiveAccess, loadAuthorizedAgreement } from "./finance-agreements-gate";
import { getAgreementVersionDoc } from "./firestore";
import { reconcileFields, summarizeReconciliation, type CanonicalSnapshot, type FieldReconciliationDto, type ReconciliationState } from "./reconciliation-compare";
import { loadAgreementAccounts, loadCanonicalIdentity, loadCounterpartyDoc, loadRestrictedExtraction, restrictedIdentityValues } from "./reconciliation-loaders";
import { defaultVersionNumber, formatIssues } from "./service-common";
import {
  agreementRefSchema,
  financeAgreementsInvalidInputResult,
  financeAgreementsNotFoundResult,
  type AgreementVersionStatus,
  type CounterpartyType,
  type FinanceAgreementsServiceResult,
} from "./types";

// Step 14A: the cross-verification READ service.
//
// Compares an Agreement version's field values with what CreatorOps already holds for the
// counterparty (master data, Partner Accounts, the canonical restricted identity record) and reports,
// per field, MATCH / MISSING_IN_CREATOROPS / MISSING_IN_AGREEMENT / MISMATCH / NOT_APPLICABLE /
// RESTRICTED / UNAVAILABLE. The comparison itself is the pure reconciliation-compare.ts; this file
// only decides what the actor may see, loads the two sides, and shapes the result.
//
// READ ONLY. Never writes a Partner, Vendor, KYC or Agreement document - a reconciliation read (like an
// extraction) can never change a master record. Fixing a difference is a separate, explicit command
// (master-data-commands.ts) that goes through the OWNING module.
//
// Restricted identity: values are compared ONLY when the actor holds BOTH finance_contracts (the
// extracted values live in the restricted extraction record) AND the counterparty's identity category.
// Otherwise every identity field is RESTRICTED - no value, no match/mismatch result - and neither
// restricted store is even read.

export type AgreementReconciliationDto = {
  agreementRef: string;
  version: number;
  versionStatus: AgreementVersionStatus;
  counterpartyType: CounterpartyType;
  // The version is confirmed (its terms are frozen); resolutions in the Agreement are then unavailable.
  versionConfirmed: boolean;
  // Identity fields were actually compared (the actor holds finance_contracts AND the identity category).
  identityCompared: boolean;
  // Opaque ref of the extraction run the identity values came from, only when identity was compared.
  extractionRunRef: string | null;
  fields: FieldReconciliationDto[];
  summary: Record<ReconciliationState, number>;
};

const reconciliationInputSchema = z.object({ agreementRef: agreementRefSchema, version: z.number().int().min(1).optional() }).strict();

export async function getAgreementReconciliation(actor: ActorContext | null, rawInput: unknown): Promise<FinanceAgreementsServiceResult<AgreementReconciliationDto>> {
  const candidate = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
  // Read gate = finance feature + LIVE Record Scope. Knowing an agreementRef never grants access.
  const loaded = await loadAuthorizedAgreement(actor, typeof candidate.agreementRef === "string" ? candidate.agreementRef : "");
  if (!loaded.ok) return loaded.error;
  const { head, counterpartyType } = loaded.authorized;
  const viewer = actor!;

  const parsed = reconciliationInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeAgreementsInvalidInputResult(formatIssues(parsed.error));

  const version = await getAgreementVersionDoc(head.agreementRef, parsed.data.version ?? defaultVersionNumber(head));
  if (!version) return financeAgreementsNotFoundResult();
  const counterparty = await loadCounterpartyDoc(head);
  if (!counterparty) return financeAgreementsNotFoundResult();

  const isPartner = counterparty.type === "PARTNER";
  const [canManage, contracts, identityCategory, ownerEdit, ownerIdentity] = await Promise.all([
    canPerformAction(viewer, "finance", "manage_agreements"),
    requireContractSensitiveAccess(viewer),
    requireIdentitySensitiveAccess(viewer, counterpartyType),
    isPartner ? requirePartnersAccess(viewer, "edit") : requireVendorsAccess(viewer, "edit"),
    isPartner ? requirePartnersAccess(viewer, "manage_partner_restricted_identity") : requireVendorsAccess(viewer, "manage_vendor_restricted_identity"),
  ]);
  const identityVisible = contracts.ok && identityCategory.ok;

  const master = counterparty.type === "PARTNER" ? counterparty.partner : counterparty.vendor;
  const accounts = counterparty.type === "PARTNER" ? await loadAgreementAccounts(version, counterparty.partner) : null;
  const subjectUid = counterparty.type === "PARTNER" ? counterparty.partner.uid : counterparty.vendor.uid;

  // The restricted stores are consulted ONLY when the actor may see identity comparisons.
  const identity = identityVisible ? await loadCanonicalIdentity(counterpartyType, subjectUid) : null;
  const restricted = identityVisible ? await loadRestrictedExtraction(version, { attachedOnly: false }) : null;

  const canonical: CanonicalSnapshot = {
    counterpartyType,
    legalName: master.legalName,
    displayName: master.displayName,
    email: master.email,
    phone: master.phone,
    regionIds: master.regionIds,
    accounts: accounts ? accounts.map((account) => ({ platform: normalizePlatformIdentifier(account.platform), profileUrl: account.profileUrl, displayName: account.displayName, handle: account.handle })) : null,
    identity,
  };

  const fields = reconcileFields({
    counterpartyType,
    identityVisible,
    canManageAgreements: canManage,
    versionOpen: head.openVersion === version.version && version.status === "DRAFT" && version.confirmation === null,
    ownerMayEditContact: ownerEdit.ok,
    ownerMayManageIdentity: ownerIdentity.ok && identityVisible,
    canonical,
    entries: reconciliationEntriesForVersion(version),
    restrictedExtracted: restrictedIdentityValues(restricted?.doc ?? null),
  });

  return {
    ok: true,
    data: {
      agreementRef: head.agreementRef,
      version: version.version,
      versionStatus: version.status,
      counterpartyType,
      versionConfirmed: version.confirmation !== null,
      identityCompared: identityVisible,
      extractionRunRef: identityVisible ? (restricted?.runRef ?? null) : null,
      fields,
      summary: summarizeReconciliation(fields),
    },
  };
}
