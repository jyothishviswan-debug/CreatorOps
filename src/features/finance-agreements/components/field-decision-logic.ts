import { AGREEMENT_FIELD_BY_KEY, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { AgreementEntryDecision, AgreementFieldOrigin } from "@/server/finance-agreements/types";

import { decisionChip, type ChipSpec } from "../format";

// Step 14B: which decision affordances a field offers, derived from the registry (the same rules the server's
// checkFieldDecisionValue enforces), so the UI never offers what the server would refuse.
//
//   DECIDED fields:   Use value (ACCEPTED) | Enter value (CORRECTED) | Not applicable | Unavailable
//   identity VALUES:  Acknowledge (ACCEPTED, no value ever) | Not applicable | Unavailable   (never Enter value)
//   COMPUTED fields:  none (agreementType, partnerRef, partnerAccountRefs, the identity status fields)
//   requiredForConfirm "always" fields (counterparty name, effective date) never offer Not applicable / Unavailable.
export type DecisionActionKind = "USE_VALUE" | "ENTER_VALUE" | "NOT_APPLICABLE" | "UNAVAILABLE";
export type DecisionKind = "ACCEPTED" | "CORRECTED" | "NOT_APPLICABLE" | "UNAVAILABLE";

export type DecisionAction = { kind: DecisionActionKind; decision: DecisionKind; label: string; pressed: boolean };

// The label of the "keep this value" action, by where the candidate value came from.
export function keepValueLabel(origin: AgreementFieldOrigin | null): string {
  if (origin === "EXTRACTED") return "Use extracted";
  if (origin === "MASTER_DATA") return "Use CreatorOps value";
  return "Keep value";
}

export function decisionActionsFor(input: { fieldKey: AgreementFieldKey; decision: AgreementEntryDecision | null; origin: AgreementFieldOrigin | null; hasValue: boolean }): DecisionAction[] {
  const field = AGREEMENT_FIELD_BY_KEY[input.fieldKey];
  if (!field || field.mode !== "DECIDED") return [];
  const { decision } = input;
  const actions: DecisionAction[] = [];

  if (field.identityValue) {
    actions.push({ kind: "USE_VALUE", decision: "ACCEPTED", label: "Acknowledge", pressed: decision === "ACCEPTED" });
  } else {
    if (input.hasValue) actions.push({ kind: "USE_VALUE", decision: "ACCEPTED", label: keepValueLabel(input.origin), pressed: decision === "ACCEPTED" });
    actions.push({ kind: "ENTER_VALUE", decision: "CORRECTED", label: "Enter value", pressed: decision === "CORRECTED" });
  }
  if (field.requiredForConfirm !== "always") {
    actions.push({ kind: "NOT_APPLICABLE", decision: "NOT_APPLICABLE", label: "Not applicable", pressed: decision === "NOT_APPLICABLE" });
    actions.push({ kind: "UNAVAILABLE", decision: "UNAVAILABLE", label: "Unavailable", pressed: decision === "UNAVAILABLE" });
  }
  return actions;
}

// The state display next to the controls. A field with no entry that must be decided deliberately reads
// "Needs decision"; a PENDING proposal reads "Needs confirmation" - never an implied acceptance.
export function decisionStateChip(decision: AgreementEntryDecision | null, options: { explicitDecisionRequired: boolean }): ChipSpec {
  if (decision === null) return options.explicitDecisionRequired ? { label: "Needs decision", tone: "orange" } : { label: "Not set", tone: "gray" };
  return decisionChip(decision);
}
