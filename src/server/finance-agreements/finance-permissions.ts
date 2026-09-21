import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { canAccessSensitive } from "@/server/authz/sensitive";
import type { ActorContext } from "@/server/authz/types";

import { FINANCE_CONTRACTS_CATEGORY, IDENTITY_CATEGORY_BY_COUNTERPARTY } from "./finance-agreements-gate";
import { COUNTERPARTY_TYPES, financeAgreementsInvalidInputResult, financeAgreementsUnauthorizedResult, counterpartyTypeSchema, type CounterpartyType, type FinanceAgreementsServiceResult } from "./types";
import type { FinanceAgreementPermissionsDto } from "./workspace-dto";

// Step 14B: what the browser may OFFER, computed from REAL grants (feature / action / sensitive category) - never from a
// role name and never a substitute for the services' own gates (every mutation re-checks server-side; these booleans only
// decide which buttons are rendered, so nothing is revealed and then hidden).
//
//   canView                   `finance` feature view
//   canManage                 canView + manage_agreements
//   canActivate               canView + activate_agreements
//   canViewContractDetail     canView + finance_contracts
//   canViewIdentity(type)     canView + the counterparty's identity category (payment_details | vendor_payment_details)
//   canManageCounterpartyKyc  canView + the OWNING module's feature + its manage_*_restricted_identity action + the identity category

export type PermissionInputs = {
  financeView: boolean;
  manageAgreements: boolean;
  activateAgreements: boolean;
  financeContracts: boolean;
  identity: Record<CounterpartyType, { category: boolean; owningView: boolean; owningKycAction: boolean }>;
};

const NO_TYPE_DETAIL = { canViewIdentity: false, canManageCounterpartyKyc: false };

// Pure derivation (unit-tested): every boolean requires the finance feature first - a role without it holds nothing here.
export function deriveFinanceAgreementPermissions(inputs: PermissionInputs, counterpartyType: CounterpartyType | null): FinanceAgreementPermissionsDto {
  const view = inputs.financeView;
  const byType = (type: CounterpartyType) => {
    const item = inputs.identity[type];
    return { canViewIdentity: view && item.category, canManageCounterpartyKyc: view && item.category && item.owningView && item.owningKycAction };
  };
  const byCounterpartyType: FinanceAgreementPermissionsDto["byCounterpartyType"] = { PARTNER: byType("PARTNER"), VENDOR: byType("VENDOR") };
  const selected = counterpartyType ? byCounterpartyType[counterpartyType] : NO_TYPE_DETAIL;
  return {
    canView: view,
    canManage: view && inputs.manageAgreements,
    canActivate: view && inputs.activateAgreements,
    canViewContractDetail: view && inputs.financeContracts,
    canViewIdentity: selected.canViewIdentity,
    canManageCounterpartyKyc: selected.canManageCounterpartyKyc,
    counterpartyType,
    byCounterpartyType,
  };
}

export const NO_FINANCE_AGREEMENT_PERMISSIONS: FinanceAgreementPermissionsDto = deriveFinanceAgreementPermissions(
  { financeView: false, manageAgreements: false, activateAgreements: false, financeContracts: false, identity: { PARTNER: { category: false, owningView: false, owningKycAction: false }, VENDOR: { category: false, owningView: false, owningKycAction: false } } },
  null,
);

// Reads the grants (a handful of small documents) and derives the DTO. An absent actor (not signed in) gets the all-false DTO.
export async function computeFinanceAgreementPermissions(actor: ActorContext | null, counterpartyType: CounterpartyType | null = null): Promise<FinanceAgreementPermissionsDto> {
  if (!actor) return { ...NO_FINANCE_AGREEMENT_PERMISSIONS, counterpartyType };
  const [financeView, manageAgreements, activateAgreements, financeContracts, partnersView, vendorsView, partnerKycAction, vendorKycAction, partnerCategory, vendorCategory] = await Promise.all([
    canAccessFeature(actor, "finance"),
    canPerformAction(actor, "finance", "manage_agreements"),
    canPerformAction(actor, "finance", "activate_agreements"),
    canAccessSensitive(actor, FINANCE_CONTRACTS_CATEGORY),
    canAccessFeature(actor, "partners"),
    canAccessFeature(actor, "vendors"),
    canPerformAction(actor, "partners", "manage_partner_restricted_identity"),
    canPerformAction(actor, "vendors", "manage_vendor_restricted_identity"),
    canAccessSensitive(actor, IDENTITY_CATEGORY_BY_COUNTERPARTY.PARTNER),
    canAccessSensitive(actor, IDENTITY_CATEGORY_BY_COUNTERPARTY.VENDOR),
  ]);
  return deriveFinanceAgreementPermissions(
    {
      financeView,
      manageAgreements,
      activateAgreements,
      financeContracts,
      identity: {
        PARTNER: { category: partnerCategory, owningView: partnersView, owningKycAction: partnerKycAction },
        VENDOR: { category: vendorCategory, owningView: vendorsView, owningKycAction: vendorKycAction },
      },
    },
    counterpartyType,
  );
}

// GET /api/finance/permissions?counterpartyType= . Any signed-in actor may ask about ITSELF (the answer is the actor's own
// grants); an unauthenticated caller is denied; a role without the finance feature simply gets canView:false and every other
// boolean false (a page uses that to render the neutral denied state, no flash).
export async function getFinanceAgreementPermissions(actor: ActorContext | null, rawCounterpartyType?: unknown): Promise<FinanceAgreementsServiceResult<FinanceAgreementPermissionsDto>> {
  if (!actor) return financeAgreementsUnauthorizedResult("not_authenticated");
  let counterpartyType: CounterpartyType | null = null;
  if (rawCounterpartyType !== undefined && rawCounterpartyType !== null && rawCounterpartyType !== "") {
    const parsed = counterpartyTypeSchema.safeParse(rawCounterpartyType);
    if (!parsed.success) return financeAgreementsInvalidInputResult(`counterpartyType must be one of ${COUNTERPARTY_TYPES.join(", ")}.`);
    counterpartyType = parsed.data;
  }
  return { ok: true, data: await computeFinanceAgreementPermissions(actor, counterpartyType) };
}
