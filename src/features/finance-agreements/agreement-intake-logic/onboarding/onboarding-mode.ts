import type { CounterpartyType } from "@/server/finance-agreements/types";
import type { FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

import { agreementForOption, resolveAgreementFor, type AgreementForChoice } from "../../agreement-for";

// Step 14B.1 onboarding, the MODE choice of section 1 (pure).
//
// After the person picks Partner (Instagram / YouTube / Instagram + YouTube) or Vendor they choose HOW the counterparty is identified:
//   existing  `Select existing Partner`            the whole current flow (search, accounts, Start draft) - the DEFAULT, nothing changes
//   new       `Create new Partner from Agreement`  the onboarding wizard: read the signed Agreement, check for an existing record, create it
// The platform choice still means ONE Partner (several canonical Partner Accounts), never separate Instagram / YouTube Partners.
//
// Creating needs the OWNING module's create right on top of manage_agreements. The booleans below come from the SERVER (the page computes
// them before render), so a person who may only review is told plainly and the final step is rendered disabled - never revealed then hidden.

export type OnboardingModeChoice = "existing" | "new";
export const DEFAULT_ONBOARDING_MODE: OnboardingModeChoice = "existing";

export type OnboardingModeOption = { value: OnboardingModeChoice; title: string; description: string };

const noun = (type: CounterpartyType): string => (type === "PARTNER" ? "Partner" : "Vendor");

export function existingModeTitle(type: CounterpartyType): string {
  return `Select existing ${noun(type)}`;
}
export function newModeTitle(type: CounterpartyType): string {
  return `Create new ${noun(type)} from Agreement`;
}

// The two cards. The `new` card explains the permission gap up front (it stays selectable: review is allowed without the create right).
export function onboardingModeOptions(type: CounterpartyType, permissions: Pick<FinanceAgreementPermissionsDto, "canCreatePartner" | "canCreateVendor">): OnboardingModeOption[] {
  const canCreate = type === "PARTNER" ? permissions.canCreatePartner : permissions.canCreateVendor;
  const name = noun(type);
  return [
    { value: "existing", title: existingModeTitle(type), description: `Choose a ${name} that is already in CreatorOps.` },
    {
      value: "new",
      title: newModeTitle(type),
      description: canCreate ? `Read the signed Agreement, check for an existing ${name}, then create one.` : `You can read and review the Agreement here, but creating a new ${name} needs permission.`,
    },
  ];
}

export type CreateRight = { canCreate: boolean; reason: string | null; missing: "MANAGE" | "COUNTERPARTY" | "ACCOUNTS" | null };

// Whether the person may run the final `create` step for a NEW record. `needsAccounts`: a Partner with Partner Accounts also needs the
// account right. The server re-checks every one of these (the typed blocker codes counterparty_create_not_permitted / account_management_not_permitted).
export function createRight(permissions: FinanceAgreementPermissionsDto, type: CounterpartyType, needsAccounts: boolean): CreateRight {
  const name = noun(type);
  if (!permissions.canManage) return { canCreate: false, reason: "You need the Manage Agreements permission to start an Agreement.", missing: "MANAGE" };
  const canCreateRecord = type === "PARTNER" ? permissions.canCreatePartner : permissions.canCreateVendor;
  if (!canCreateRecord) {
    return { canCreate: false, reason: `You can review this Agreement, but you do not have permission to create a new ${name}. Select an existing ${name}, or ask someone with access to create it.`, missing: "COUNTERPARTY" };
  }
  if (type === "PARTNER" && needsAccounts && !permissions.canManagePartnerAccounts) {
    return { canCreate: false, reason: "You do not have permission to add Partner Accounts. Ask someone with access to add them.", missing: "ACCOUNTS" };
  }
  return { canCreate: true, reason: null, missing: null };
}

// Using an EXISTING record found by the duplicate check needs only manage_agreements (it creates nothing but the Agreement draft).
export function canUseExisting(permissions: Pick<FinanceAgreementPermissionsDto, "canManage">): boolean {
  return permissions.canManage;
}

// The platforms whose Partner Account rows the wizard shows: fixed by the platform choice, none for a Vendor.
export function accountPlatformsFor(choice: AgreementForChoice | null): string[] {
  return choice ? resolveAgreementFor(choice).platforms : [];
}

export function counterpartyTypeOfChoice(choice: AgreementForChoice | null): CounterpartyType | null {
  return choice ? agreementForOption(choice).counterpartyType : null;
}

export type OnboardingSelection = { mode: OnboardingModeChoice; choice: AgreementForChoice | null };
export const EMPTY_ONBOARDING_SELECTION: OnboardingSelection = { mode: DEFAULT_ONBOARDING_MODE, choice: null };

// The initial selection from a deep link (?counterpartyType=&mode=new): a Vendor has one card; a Partner still needs the platform choice
// (never guessed), so the wizard opens as soon as the person picks it.
export function initialOnboardingSelection(seed: { mode: "new"; counterpartyType: CounterpartyType } | null | undefined): OnboardingSelection {
  if (!seed) return EMPTY_ONBOARDING_SELECTION;
  return { mode: "new", choice: seed.counterpartyType === "VENDOR" ? "VENDOR" : null };
}

// The wizard is showing: the person chose to create AND has picked which kind (a Partner still needs its platform choice).
export function isWizardActive(selection: OnboardingSelection): boolean {
  return selection.mode === "new" && selection.choice !== null;
}
