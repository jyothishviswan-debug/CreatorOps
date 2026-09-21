import { describe, expect, it } from "vitest";

import { deriveFinanceAgreementPermissions, NO_FINANCE_AGREEMENT_PERMISSIONS, type PermissionInputs } from "./finance-permissions";

const none: PermissionInputs["identity"][keyof PermissionInputs["identity"]] = { category: false, owningView: false, owningKycAction: false };
const NOTHING: PermissionInputs = { financeView: false, manageAgreements: false, activateAgreements: false, financeContracts: false, partnersCreate: false, vendorsCreate: false, partnerAccountsManage: false, identity: { PARTNER: none, VENDOR: none } };
const full = { category: true, owningView: true, owningKycAction: true };

describe("deriveFinanceAgreementPermissions", () => {
  it("nothing granted -> every boolean false", () => {
    const dto = deriveFinanceAgreementPermissions(NOTHING, null);
    expect(dto).toMatchObject({ canView: false, canManage: false, canActivate: false, canViewContractDetail: false, canViewIdentity: false, canManageCounterpartyKyc: false, canCreatePartner: false, canCreateVendor: false, canManagePartnerAccounts: false, counterpartyType: null });
    expect(NO_FINANCE_AGREEMENT_PERMISSIONS).toEqual(dto);
  });

  it("every other boolean requires the finance feature first (an action / category without the feature grants nothing)", () => {
    const dto = deriveFinanceAgreementPermissions({ financeView: false, manageAgreements: true, activateAgreements: true, financeContracts: true, partnersCreate: true, vendorsCreate: true, partnerAccountsManage: true, identity: { PARTNER: full, VENDOR: full } }, "PARTNER");
    expect(dto).toMatchObject({ canView: false, canManage: false, canActivate: false, canViewContractDetail: false, canViewIdentity: false, canManageCounterpartyKyc: false });
    expect(dto.byCounterpartyType).toEqual({ PARTNER: { canViewIdentity: false, canManageCounterpartyKyc: false }, VENDOR: { canViewIdentity: false, canManageCounterpartyKyc: false } });
  });

  it("a Manager-like grant (view + manage, no activate, no sensitive) can prepare but not activate or see identity", () => {
    const dto = deriveFinanceAgreementPermissions({ ...NOTHING, financeView: true, manageAgreements: true, identity: { PARTNER: { ...none, owningView: true, owningKycAction: true }, VENDOR: { ...none, owningView: true, owningKycAction: true } } }, "PARTNER");
    expect(dto).toMatchObject({ canView: true, canManage: true, canActivate: false, canViewContractDetail: false, canViewIdentity: false, canManageCounterpartyKyc: false, counterpartyType: "PARTNER" });
  });

  it("a Head/Admin-like grant holds everything", () => {
    const dto = deriveFinanceAgreementPermissions({ financeView: true, manageAgreements: true, activateAgreements: true, financeContracts: true, partnersCreate: true, vendorsCreate: true, partnerAccountsManage: true, identity: { PARTNER: full, VENDOR: full } }, "VENDOR");
    expect(dto).toMatchObject({ canView: true, canManage: true, canActivate: true, canViewContractDetail: true, canViewIdentity: true, canManageCounterpartyKyc: true, counterpartyType: "VENDOR" });
  });

  it("the identity booleans are per counterparty type and use that type's OWN category / owning action", () => {
    const inputs: PermissionInputs = { financeView: true, manageAgreements: true, activateAgreements: false, financeContracts: false, partnersCreate: false, vendorsCreate: false, partnerAccountsManage: false, identity: { PARTNER: full, VENDOR: { category: true, owningView: true, owningKycAction: false } } };
    expect(deriveFinanceAgreementPermissions(inputs, "PARTNER")).toMatchObject({ canViewIdentity: true, canManageCounterpartyKyc: true });
    expect(deriveFinanceAgreementPermissions(inputs, "VENDOR")).toMatchObject({ canViewIdentity: true, canManageCounterpartyKyc: false });
    expect(deriveFinanceAgreementPermissions(inputs, null)).toMatchObject({ canViewIdentity: false, canManageCounterpartyKyc: false, byCounterpartyType: { PARTNER: { canViewIdentity: true, canManageCounterpartyKyc: true }, VENDOR: { canViewIdentity: true, canManageCounterpartyKyc: false } } });
  });

  it("managing KYC needs the category AND the owning module's feature AND its restricted-identity action", () => {
    const base = { financeView: true, manageAgreements: true, activateAgreements: false, financeContracts: false, partnersCreate: false, vendorsCreate: false, partnerAccountsManage: false };
    for (const missing of ["category", "owningView", "owningKycAction"] as const) {
      const identity = { ...full, [missing]: false };
      const dto = deriveFinanceAgreementPermissions({ ...base, identity: { PARTNER: identity, VENDOR: identity } }, "PARTNER");
      expect(dto.canManageCounterpartyKyc, missing).toBe(false);
    }
  });

  it("Step 14B.1: the onboarding booleans come from the OWNING grants and are independent of manage_agreements (each also needs the finance feature)", () => {
    const owning = { partnersCreate: true, vendorsCreate: true, partnerAccountsManage: true };
    // the owning grants without the finance feature hold nothing
    expect(deriveFinanceAgreementPermissions({ ...NOTHING, ...owning }, null)).toMatchObject({ canCreatePartner: false, canCreateVendor: false, canManagePartnerAccounts: false });
    // finance view + manage but NO owning create right: can manage Agreements yet cannot create a counterparty
    const manageOnly = deriveFinanceAgreementPermissions({ ...NOTHING, financeView: true, manageAgreements: true }, "PARTNER");
    expect(manageOnly).toMatchObject({ canManage: true, canCreatePartner: false, canCreateVendor: false, canManagePartnerAccounts: false });
    // each owning right stands alone
    expect(deriveFinanceAgreementPermissions({ ...NOTHING, financeView: true, partnersCreate: true }, null)).toMatchObject({ canCreatePartner: true, canCreateVendor: false, canManagePartnerAccounts: false });
    expect(deriveFinanceAgreementPermissions({ ...NOTHING, financeView: true, vendorsCreate: true }, null)).toMatchObject({ canCreatePartner: false, canCreateVendor: true, canManagePartnerAccounts: false });
    expect(deriveFinanceAgreementPermissions({ ...NOTHING, financeView: true, partnerAccountsManage: true }, null)).toMatchObject({ canCreatePartner: false, canCreateVendor: false, canManagePartnerAccounts: true });
    // owning rights without manage_agreements do not make the actor an Agreement manager
    expect(deriveFinanceAgreementPermissions({ ...NOTHING, financeView: true, ...owning }, null)).toMatchObject({ canManage: false, canCreatePartner: true, canCreateVendor: true, canManagePartnerAccounts: true });
    // the onboarding booleans are not per counterparty type: they are the same whichever type is requested
    for (const type of ["PARTNER", "VENDOR", null] as const) expect(deriveFinanceAgreementPermissions({ ...NOTHING, financeView: true, ...owning }, type)).toMatchObject({ canCreatePartner: true, canCreateVendor: true, canManagePartnerAccounts: true });
  });
});
