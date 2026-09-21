import { AGREEMENT_FIELD_BY_KEY, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { CounterpartyType } from "@/server/finance-agreements/types";

import type { FinanceApiBlocker } from "./api-client";
import { fieldPlacement, type IntakeSectionId } from "./field-view-model";
import { fieldLabel } from "./format";

// Step 14B: the confirm gate's `not_ready` blockers -> a plain-language list with jump targets (pure).
// The server's messages carry internal paths ("dates.effectiveFrom: Invalid input: expected string, received null"), so the
// wording here is the UI's own; the server's text is only used (path prefix stripped) for issues the UI has no wording for.
export type ConfirmBlockerView = {
  code: string;
  fieldKey: AgreementFieldKey | null;
  message: string;
  // Which intake section the person must go to (null when it cannot be placed).
  section: IntakeSectionId | null;
  // The DOM id to jump to: `field-<fieldKey>` when the blocker names a field, else the section's anchor.
  anchorId: string;
};

export const fieldAnchorId = (fieldKey: AgreementFieldKey): string => `field-${fieldKey}`;
export const sectionAnchorId = (section: IntakeSectionId | "review"): string => `section-${section}`;

function knownFieldKey(value: string | undefined): AgreementFieldKey | null {
  return value !== undefined && Object.prototype.hasOwnProperty.call(AGREEMENT_FIELD_BY_KEY, value) ? (value as AgreementFieldKey) : null;
}

// "commercial.currency: A currency is required..." -> "A currency is required..."; a raw schema type error -> a generic instruction.
export function humanizeIssueText(message: string): string {
  const stripped = message.replace(/^[A-Za-z0-9_.[\]]+:\s*/, "").trim();
  if (stripped.length === 0 || /^(Invalid input|Invalid option|Invalid enum|expected [a-z]+, received)/.test(stripped)) return "Enter a valid value.";
  return stripped;
}

// The part of a value_invalid message after "<Field label>: ".
function afterLabel(message: string, label: string): string {
  return humanizeIssueText(message.startsWith(`${label}: `) ? message.slice(label.length + 2) : message);
}

export function describeConfirmBlocker(blocker: FinanceApiBlocker, counterpartyType?: CounterpartyType): ConfirmBlockerView {
  const fieldKey = knownFieldKey(blocker.fieldKey);
  const label = fieldKey ? fieldLabel(fieldKey) : null;
  const noun = counterpartyType === "VENDOR" ? "Vendor" : counterpartyType === "PARTNER" ? "Partner" : "this kind of";
  let message: string;

  switch (blocker.code) {
    case "field_undecided":
      message = `${label ?? "A field"} must be decided: use a value, or mark it Not applicable / Unavailable.`;
      break;
    case "field_pending":
      message = `${label ?? "A field"} has a proposed value that needs your decision.`;
      break;
    case "decision_without_value":
      message = `${label ?? "A field"} was accepted without a value. Enter one, or mark it Unavailable.`;
      break;
    case "value_invalid":
      message = label ? `${label}: ${afterLabel(blocker.message, label)}` : humanizeIssueText(blocker.message);
      break;
    case "required_field_missing":
      message = `${label ?? "A required field"} is required.`;
      break;
    case "field_not_applicable":
      message = `${label ?? "A field"} does not apply to ${counterpartyType ? `a ${noun}` : noun} Agreement.`;
      break;
    case "terms_invalid":
    case "contact_invalid":
      message = `${label ?? (blocker.code === "terms_invalid" ? "Terms" : "Contact details")}: ${humanizeIssueText(blocker.message)}`;
      break;
    default:
      message = humanizeIssueText(blocker.message);
  }

  const section: IntakeSectionId | null = fieldKey ? fieldPlacement(fieldKey).section : blocker.code === "terms_invalid" ? "commercial_terms" : blocker.code === "contact_invalid" ? "cross_verification" : null;
  return { code: blocker.code, fieldKey, message, section, anchorId: fieldKey ? fieldAnchorId(fieldKey) : sectionAnchorId(section ?? "review") };
}

// The full list: humanized, de-duplicated (same message + anchor), in the order the server reported them.
export function describeConfirmBlockers(blockers: readonly FinanceApiBlocker[] | undefined, counterpartyType?: CounterpartyType): ConfirmBlockerView[] {
  const seen = new Set<string>();
  const views: ConfirmBlockerView[] = [];
  for (const blocker of blockers ?? []) {
    const view = describeConfirmBlocker(blocker, counterpartyType);
    const key = `${view.anchorId}|${view.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    views.push(view);
  }
  return views;
}

export function blockerHeadline(count: number): string {
  if (count === 0) return "This Agreement is ready to confirm.";
  return `${count} ${count === 1 ? "item needs" : "items need"} attention before this Agreement can be confirmed.`;
}
