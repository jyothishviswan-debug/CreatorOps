import type { CounterpartyPartnerAccountDto, CounterpartySearchResultDto } from "@/server/finance-agreements/workspace-dto";
import type { CounterpartyType } from "@/server/finance-agreements/types";

import { AGREEMENT_FOR_OPTIONS, buildAgreementFor, groupAccountsByPlatform, suggestedAccountSelection, type AccountScope, type AccountSelection, type AgreementForChoice, type AgreementForResult } from "../agreement-for";
import type { ComboboxOption } from "../components/combobox-logic";

// Step 14B intake: the pure wiring behind section 1 (`Agreement for`): the state shape, the transitions and the derived facts the
// component renders. The component holds ONE `AgreementForState`; every change goes through a function here so the rules
// (a new choice / counterparty resets what depended on it; a single eligible account is suggested, never several) are tested.

export type AgreementForState = {
  choice: AgreementForChoice | null;
  counterparty: ComboboxOption | null;
  scope: AccountScope | null;
  selection: AccountSelection;
  // The type of a counterparty preselected by a deep link (?counterpartyType=&ref=) while no card is chosen yet: picking a card of the
  // SAME type keeps that counterparty (it is only dropped when the card is of the other type).
  preselectedType?: CounterpartyType | null;
};

export const EMPTY_AGREEMENT_FOR: AgreementForState = { choice: null, counterparty: null, scope: null, selection: {} };

export function choiceCounterpartyType(choice: AgreementForChoice | null): CounterpartyType | null {
  return choice ? AGREEMENT_FOR_OPTIONS.find((option) => option.value === choice)!.counterpartyType : null;
}

// Choosing another card. Moving between Partner platform choices keeps the Partner (one canonical Partner, any platform scope) but
// drops the account picks, which depended on the platforms; moving between a Partner and a Vendor drops the counterparty.
export function selectChoice(state: AgreementForState, choice: AgreementForChoice): AgreementForState {
  if (state.choice === choice) return state;
  const currentType = choiceCounterpartyType(state.choice) ?? state.preselectedType ?? null;
  const sameType = currentType === choiceCounterpartyType(choice);
  return { choice, counterparty: sameType ? state.counterparty : null, scope: choiceCounterpartyType(choice) === "PARTNER" ? state.scope : null, selection: {}, preselectedType: null };
}

export function selectCounterparty(state: AgreementForState, counterparty: ComboboxOption | null): AgreementForState {
  if (state.counterparty?.id === counterparty?.id) return { ...state, counterparty };
  return { ...state, counterparty, selection: {} };
}

// The scope choice (Account-specific / Partner-level). Entering Account-specific suggests the ONE eligible account of a platform (never
// picks among several); leaving it forgets the picks.
export function selectScope(state: AgreementForState, scope: AccountScope, accounts: readonly CounterpartyPartnerAccountDto[]): AgreementForState {
  if (state.scope === scope) return state;
  if (scope === "PARTNER_LEVEL" || !state.choice) return { ...state, scope, selection: {} };
  const platforms = AGREEMENT_FOR_OPTIONS.find((option) => option.value === state.choice)!.platforms;
  return { ...state, scope, selection: suggestedAccountSelection(groupAccountsByPlatform(platforms, accounts)) };
}

export function selectAccount(state: AgreementForState, platform: string, partnerAccountRef: string): AgreementForState {
  return { ...state, selection: { ...state.selection, [platform]: partnerAccountRef } };
}

// The validation result of the current state (what `Start draft` sends) - null accounts (preview not loaded) are treated as none.
export function evaluateAgreementFor(state: AgreementForState, accounts: readonly CounterpartyPartnerAccountDto[] | null): AgreementForResult {
  return buildAgreementFor({ choice: state.choice, counterpartyRef: state.counterparty?.id ?? null, scope: state.scope, selection: state.selection, accounts: accounts ?? [] });
}

// Roving-radio keyboard behaviour for the card groups: Arrow keys move (wrapping), Home / End jump. Returns the new index or null.
export function radioKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function searchResultToOption(result: CounterpartySearchResultDto): ComboboxOption {
  return { id: result.ref, label: result.displayName, description: result.regions.length > 0 ? result.regions.join(", ") : undefined };
}

// How a Partner Account reads in the picker: the handle first (a display name alone never identifies an account), the display name,
// and whether it is the Partner's primary account.
export function accountLabel(account: CounterpartyPartnerAccountDto): { title: string; detail: string | null } {
  const title = account.handle ? (account.handle.startsWith("@") ? account.handle : `@${account.handle}`) : (account.displayName ?? "Unnamed account");
  const detailParts = [account.handle && account.displayName ? account.displayName : null, account.primary ? "Primary account" : null].filter((part): part is string => !!part);
  return { title, detail: detailParts.length > 0 ? detailParts.join(" · ") : null };
}
