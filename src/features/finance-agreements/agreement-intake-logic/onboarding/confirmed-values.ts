import type { OnboardingDuplicatesDto } from "@/server/finance-agreements/onboarding-dto";
import type { CounterpartyType } from "@/server/finance-agreements/types";

import { formatPlatformName, NO_VALUE_TEXT } from "../../format";
import { candidateCards, type WizardDecision } from "./duplicate-rules";
import { ONBOARDING_VENDOR_TYPES, type OnboardingForm } from "./wizard-form";

// Step 14B.1 onboarding: the CONFIRMED ONBOARDING VALUES - the last thing the person sees before anything is created (pure).
// It restates exactly what will be sent: the decision (a new record, or the existing one chosen), the reviewed profile, the Partner Accounts
// (one canonical locator each) and, when a possible match was overridden, the acknowledgement and reason that will be recorded.

export type ConfirmedRow = { label: string; value: string; muted?: boolean };

const noun = (type: CounterpartyType): string => (type === "PARTNER" ? "Partner" : "Vendor");
const or = (value: string): string => (value.trim().length > 0 ? value.trim() : NO_VALUE_TEXT);

export function decisionRow(type: CounterpartyType, decision: WizardDecision, duplicates: OnboardingDuplicatesDto | null): ConfirmedRow {
  const name = noun(type);
  if (decision.kind === "USE_EXISTING") {
    const chosen = duplicates ? candidateCards(duplicates).find((card) => card.ref === decision.ref) : null;
    return { label: "What happens", value: chosen ? `Use the existing ${name}: ${chosen.displayName}. No new ${name} is created.` : `Use the existing ${name} you chose. No new ${name} is created.` };
  }
  if (decision.kind === "CREATE_NEW") return { label: "What happens", value: `Create a new ${name} and start the Agreement draft.` };
  return { label: "What happens", value: NO_VALUE_TEXT, muted: true };
}

export function confirmedRows(input: { type: CounterpartyType; form: OnboardingForm; decision: WizardDecision; duplicates: OnboardingDuplicatesDto | null }): ConfirmedRow[] {
  const { type, form, decision, duplicates } = input;
  const rows: ConfirmedRow[] = [decisionRow(type, decision, duplicates)];
  rows.push({ label: "Name", value: or(form.displayName) });
  if (form.legalName.trim()) rows.push({ label: "Legal name", value: form.legalName.trim() });
  rows.push({ label: "Email", value: or(form.email), muted: !form.email.trim() });
  rows.push({ label: "Phone", value: or(form.phone), muted: !form.phone.trim() });
  rows.push({ label: "Region", value: or(form.regionId) });
  if (type === "VENDOR") rows.push({ label: "Vendor type", value: ONBOARDING_VENDOR_TYPES.find((option) => option.value === form.vendorType)?.label ?? NO_VALUE_TEXT });
  else {
    for (const account of form.accounts) {
      const kind = account.locatorKind === "LINK" ? "Page link" : "Handle";
      rows.push({ label: `${formatPlatformName(account.platform)} account`, value: `${kind}: ${or(account.locator)}${account.pageName.trim() ? ` · ${account.pageName.trim()}` : ""}` });
    }
  }
  if (decision.kind === "CREATE_NEW" && decision.acknowledged) rows.push({ label: "Possible match", value: `You confirmed creating a new ${noun(type)} anyway. Reason: ${or(decision.reason)}` });
  return rows;
}

// Identity details are never collected here: said plainly so nobody looks for them.
export const KYC_LATER_NOTE = "PAN, Aadhaar, GSTIN and bank details are not collected here. They are completed in the KYC section once the record exists.";
