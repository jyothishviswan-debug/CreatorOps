import { AGREEMENT_FIELD_BY_KEY, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { AgreementType } from "@/server/finance-agreements/terms";
import type { AgreementEntryDecision } from "@/server/finance-agreements/types";

import { previewAgreementType, validateCommercialTerms, validateDateOrder, type CommercialIssue } from "../../terms-validators";
import type { LocalFieldEdit } from "../intake-logic";

// Step 14B (intake): what the commercial fields currently RESOLVE to, counting unsaved local edits (pure).
// The cross-field rules the server applies at confirm (an amount needs a currency, the required content count and its unit go
// together, the termination date cannot precede the effective date) are checked here as the person edits, so the message
// appears next to the fields instead of as a confirm blocker later.

export type ResolvedField =
  | { state: "value"; value: unknown }
  | { state: "unavailable" }
  | { state: "not_applicable"; value: unknown }
  | { state: "undecided" };

export type ResolvableModel = { decision: AgreementEntryDecision | null; value: unknown; hasValue: boolean };

const isPositive = (decision: AgreementEntryDecision | null): boolean => decision === "ACCEPTED" || decision === "CORRECTED";

// A buffered edit wins over the saved entry; a PENDING entry (an unaccepted proposal / prefill) is undecided, never a value.
export function resolveField(fieldKey: AgreementFieldKey, model: ResolvableModel | undefined, pending: LocalFieldEdit | undefined): ResolvedField {
  const notApplicable = (): ResolvedField => ({ state: "not_applicable", value: AGREEMENT_FIELD_BY_KEY[fieldKey].notApplicableValue });
  if (pending) {
    if (pending.decision === "UNAVAILABLE") return { state: "unavailable" };
    if (pending.decision === "NOT_APPLICABLE") return notApplicable();
    if (pending.value !== undefined) return { state: "value", value: pending.value };
    if (model?.hasValue) return { state: "value", value: model.value };
    return { state: "undecided" };
  }
  if (!model) return { state: "undecided" };
  if (model.decision === "UNAVAILABLE") return { state: "unavailable" };
  if (model.decision === "NOT_APPLICABLE") return notApplicable();
  if (isPositive(model.decision) && model.hasValue) return { state: "value", value: model.value };
  return { state: "undecided" };
}

const valueOrNull = (resolved: ResolvedField): unknown => (resolved.state === "value" || resolved.state === "not_applicable" ? resolved.value : null);
const asRecordOrNull = <T,>(value: unknown): T | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as T) : null);
const asStringOrNull = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const asNumberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);

export type FieldResolver = (fieldKey: AgreementFieldKey) => ResolvedField;

type Component = { applicable: boolean; amountMinor: number | null };

// The cross-field problems of the commercial terms as they stand (empty when there are none, or when the relevant fields are still undecided).
export function commercialIssues(resolve: FieldResolver): CommercialIssue[] {
  const count = resolve("monthlyRequiredQualifyingContentCount");
  const unit = resolve("qualifyingUnit");
  // The count / unit pair is only judged once BOTH are decided (an undecided one is reported by the confirm gate as undecided).
  const pairDecided = count.state !== "undecided" && unit.state !== "undecided";
  return validateCommercialTerms({
    currency: asStringOrNull(valueOrNull(resolve("currency"))),
    fixedComponent: asRecordOrNull<Component>(valueOrNull(resolve("fixedComponent"))),
    accountTransferFee: asRecordOrNull<Component>(valueOrNull(resolve("accountTransferFee"))),
    advancePayment: asRecordOrNull<Component>(valueOrNull(resolve("advancePayment"))),
    incentive: asRecordOrNull<{ applicable: boolean; slabs: readonly unknown[] }>(valueOrNull(resolve("incentive"))),
    monthlyRequiredQualifyingContentCount: pairDecided ? asNumberOrNull(valueOrNull(count)) : null,
    qualifyingUnit: pairDecided ? asStringOrNull(valueOrNull(unit)) : null,
  });
}

// The message for the termination date (null when fine or when either date is not a decided value).
export function terminationDateIssue(resolve: FieldResolver): string | null {
  return validateDateOrder(asStringOrNull(valueOrNull(resolve("effectiveDate"))), asStringOrNull(valueOrNull(resolve("terminationDate"))));
}

// The Agreement type the server WILL derive from the commercial structure as it stands now (a hint only - the server is
// authoritative and an extractor's guess is never read). Undecided components count as "not stated".
export function agreementTypeHint(resolve: FieldResolver): AgreementType {
  return previewAgreementType({
    fixedComponent: asRecordOrNull<{ applicable: boolean }>(valueOrNull(resolve("fixedComponent"))),
    incentive: asRecordOrNull<{ applicable: boolean; slabs: readonly unknown[] }>(valueOrNull(resolve("incentive"))),
    monthlyRequiredQualifyingContentCount: asNumberOrNull(valueOrNull(resolve("monthlyRequiredQualifyingContentCount"))),
  });
}

// Which fields an issue message should be shown under (a field-level anchor for the message).
export function issuesByField(issues: readonly CommercialIssue[]): Partial<Record<AgreementFieldKey, string[]>> {
  const grouped: Partial<Record<AgreementFieldKey, string[]>> = {};
  for (const issue of issues) (grouped[issue.fieldKey] ??= []).push(issue.message);
  return grouped;
}
