import type { AgreementVersionDto, ContractArtifactDto } from "@/server/finance-agreements/client-dto";
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { AgreementKycStatusDto } from "@/server/finance-agreements/kyc-status-service";
import type { AgreementSourceMode, ExtractionRunStatus } from "@/server/finance-agreements/types";

import { fieldAnchorId } from "../confirm-blockers";
import { confirmedFieldValue } from "../field-values";
import type { FieldViewModel } from "../field-view-model";
import { KYC_COMPONENT_LABELS, TARGET_MONITORING_LABEL, counterpartyTypeLabel, extractionStatusChip, formatEffectivePeriod, formatPlatformList, formatUtcDate, kycComponentChip, kycStateChip, sourceModeLabel, NO_VALUE_TEXT, type ChipSpec } from "../format";
import { resolveField, type FieldResolver, type ResolvedField } from "./editors/commercial-logic";
import { valueLines } from "./editors/value-lines";
import type { IntakeCounterparty, LocalEdits } from "./intake-logic";
import { applicableKycComponents } from "./kyc-ui";

// Step 14B intake (Review & confirm): the concise grouped summary and the readiness of the draft (pure).
export type ReviewRow = { label: string; text: string; chip?: ChipSpec; anchorId?: string };
export type ReviewGroup = { key: string; title: string; rows: ReviewRow[]; chip?: ChipSpec };

// --- What a field resolves to ---------------------------------------------------------------------------------------------------------------------
// A CONFIRMED version reads its frozen terms; a draft reads the saved entries plus the unsaved edits.
export function frozenResolver(version: Pick<AgreementVersionDto, "terms" | "contactSnapshot" | "fieldProvenance">): FieldResolver {
  return (fieldKey: AgreementFieldKey): ResolvedField => {
    const decision = version.fieldProvenance?.[fieldKey]?.decision ?? null;
    if (decision === "UNAVAILABLE") return { state: "unavailable" };
    if (decision === "NOT_APPLICABLE") return { state: "not_applicable", value: confirmedFieldValue(fieldKey, version.terms, version.contactSnapshot) };
    const value = confirmedFieldValue(fieldKey, version.terms, version.contactSnapshot);
    return value === null || value === undefined ? { state: "unavailable" } : { state: "value", value };
  };
}

export function draftResolver(models: readonly FieldViewModel[], localEdits: LocalEdits): FieldResolver {
  const byKey = new Map(models.map((model) => [model.fieldKey, model]));
  return (fieldKey) => resolveField(fieldKey, byKey.get(fieldKey), localEdits[fieldKey]);
}

const CLIP = 140;
export const clip = (text: string, max = CLIP): string => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

export function describeResolved(fieldKey: AgreementFieldKey, resolved: ResolvedField, currency: string | null): string {
  switch (resolved.state) {
    case "value":
      return clip(valueLines(fieldKey, resolved.value, { currency }).join("; "));
    case "unavailable":
      return "Unavailable";
    case "not_applicable":
      return "Not applicable";
    default:
      return "Not decided yet";
  }
}

function currencyOf(resolve: FieldResolver): string | null {
  const resolved = resolve("currency");
  return resolved.state === "value" && typeof resolved.value === "string" ? resolved.value : null;
}

const asString = (resolved: ResolvedField): string | null => (resolved.state === "value" && typeof resolved.value === "string" ? resolved.value : null);

// --- source mode ---------------------------------------------------------------------------------------------------------------------------------------
// The same rule the server applies at confirm (from field ORIGINS and decisions), shown as a hint before it: no accepted extracted value =>
// Manual; only accepted extracted values => Extracted; a mix (or any corrected / manually accepted value) => Mixed.
export function sourceModeHint(models: readonly Pick<FieldViewModel, "origin" | "decision">[]): AgreementSourceMode {
  let extracted = 0;
  let manual = 0;
  for (const model of models) {
    if (model.origin === "EXTRACTED" && model.decision === "ACCEPTED") extracted += 1;
    else if (model.decision === "CORRECTED" || (model.origin === "MANUAL" && model.decision === "ACCEPTED")) manual += 1;
  }
  if (extracted === 0) return "MANUAL";
  return manual === 0 ? "EXTRACTED" : "MIXED";
}

// --- the groups ----------------------------------------------------------------------------------------------------------------------------------------
export const COMMERCIAL_SUMMARY_KEYS: readonly AgreementFieldKey[] = [
  "currency",
  "paymentCycle",
  "fixedComponent",
  "monthlyRequiredQualifyingContentCount",
  "qualifyingUnit",
  "accountTransferFee",
  "advancePayment",
  "invoiceRequired",
  "invoiceDueTerms",
  "paymentDueTerms",
  "servicesMandated",
  "incentive",
  "lfcSfc",
];

export type BuildReviewInput = {
  counterparty: IntakeCounterparty | null;
  version: Pick<AgreementVersionDto, "confirmed" | "sourceMode"> | null;
  resolve: FieldResolver;
  // Labels of the fields (registry-driven) and the models used for the source-mode hint.
  models: readonly FieldViewModel[];
  artifact: Pick<ContractArtifactDto, "fileName" | "status"> | null;
  extractionStatus: ExtractionRunStatus | null;
  extractionAttached: boolean;
  unresolvedCount: number;
  kyc: Pick<AgreementKycStatusDto, "state" | "components"> | null;
  fieldLabel: (key: AgreementFieldKey) => string;
};

export function buildReviewGroups(input: BuildReviewInput): ReviewGroup[] {
  const { resolve, counterparty } = input;
  const currency = currencyOf(resolve);
  const groups: ReviewGroup[] = [];

  groups.push({
    key: "counterparty",
    title: "Counterparty",
    rows: counterparty ? [{ label: counterpartyTypeLabel(counterparty.type), text: counterparty.displayName }] : [{ label: "Counterparty", text: NO_VALUE_TEXT }],
  });

  const platformsText = describeResolved("platforms", resolve("platforms"), currency);
  const scopeRows: ReviewRow[] = [];
  if (counterparty?.type === "PARTNER") {
    scopeRows.push({ label: "Scope", text: counterparty.mode === "account-specific" ? "Account-specific" : "Partner-level" });
    scopeRows.push({ label: "Platforms", text: counterparty.platforms.length > 0 ? formatPlatformList(counterparty.platforms) : platformsText, anchorId: fieldAnchorId("platforms") });
  } else scopeRows.push({ label: "Scope", text: "Vendor (no platform scope)" });
  groups.push({ key: "scope", title: "Platform / account scope", rows: scopeRows });

  const artifactRows: ReviewRow[] = [];
  if (input.artifact) artifactRows.push({ label: "Contract", text: input.artifact.fileName });
  else artifactRows.push({ label: "Contract", text: "No Agreement uploaded (manual entry)" });
  if (input.extractionStatus) artifactRows.push({ label: "Extraction", text: input.extractionAttached ? "Attached to this draft" : "Not attached to this draft", chip: extractionStatusChip(input.extractionStatus) });
  groups.push({ key: "artifact", title: "Contract artifact", rows: artifactRows });

  groups.push({
    key: "discrepancies",
    title: "Unresolved discrepancies",
    chip: input.unresolvedCount > 0 ? { label: `${input.unresolvedCount} open`, tone: "orange" } : { label: "None", tone: "default" },
    rows: [{ label: "Fields to decide", text: input.unresolvedCount === 0 ? "None" : String(input.unresolvedCount) }],
  });

  const kycRows: ReviewRow[] = [];
  if (input.kyc) {
    const type = counterparty?.type ?? "PARTNER";
    kycRows.push({ label: "Status", text: kycStateChip(input.kyc.state).label, chip: kycStateChip(input.kyc.state) });
    for (const component of applicableKycComponents(type)) kycRows.push({ label: KYC_COMPONENT_LABELS[component], text: kycComponentChip(input.kyc.components[component]).label });
  } else kycRows.push({ label: "Status", text: "Not loaded yet" });
  groups.push({ key: "kyc", title: "KYC readiness", rows: kycRows });

  groups.push({
    key: "terms",
    title: "Payment-affecting terms",
    rows: COMMERCIAL_SUMMARY_KEYS.map((key) => ({ label: input.fieldLabel(key), text: describeResolved(key, resolve(key), currency), anchorId: fieldAnchorId(key) })),
  });

  groups.push({
    key: "targets",
    title: "Performance targets",
    chip: { label: TARGET_MONITORING_LABEL, tone: "gray" },
    rows: [{ label: input.fieldLabel("performanceTargets"), text: describeResolved("performanceTargets", resolve("performanceTargets"), currency), anchorId: fieldAnchorId("performanceTargets") }],
  });

  const effectiveFrom = asString(resolve("effectiveDate"));
  const effectiveTo = asString(resolve("terminationDate"));
  const signed = asString(resolve("signedDate"));
  groups.push({
    key: "dates",
    title: "Effective dates",
    rows: [
      { label: "Effective period", text: effectiveFrom || effectiveTo ? formatEffectivePeriod(effectiveFrom, effectiveTo) : describeResolved("effectiveDate", resolve("effectiveDate"), currency), anchorId: fieldAnchorId("effectiveDate") },
      { label: "Signed", text: signed ? formatUtcDate(signed) : describeResolved("signedDate", resolve("signedDate"), currency), anchorId: fieldAnchorId("signedDate") },
    ],
  });

  const mode = input.version?.confirmed ? input.version.sourceMode : sourceModeHint(input.models);
  groups.push({ key: "source", title: "Source mode", rows: [{ label: input.version?.confirmed ? "Recorded" : "So far", text: sourceModeLabel(mode) }] });
  return groups;
}

// --- readiness --------------------------------------------------------------------------------------------------------------------------------------------
export type ReadinessItem = { message: string; anchorId: string };

// What still stands between the person and Confirm, from what the browser already knows (the server's own blockers arrive when Confirm is
// tried and are shown by the section). A field with an unsaved edit counts as decided: Confirm saves the edits first.
export function buildReadiness(input: { unresolved: readonly Pick<FieldViewModel, "fieldKey" | "label">[]; localEdits: LocalEdits; commercialIssues: readonly { fieldKey: AgreementFieldKey; message: string }[] }): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  for (const field of input.unresolved) {
    if (input.localEdits[field.fieldKey] !== undefined) continue;
    items.push({ message: `${field.label} needs a decision.`, anchorId: fieldAnchorId(field.fieldKey) });
  }
  for (const issue of input.commercialIssues) items.push({ message: issue.message, anchorId: fieldAnchorId(issue.fieldKey) });
  return items;
}

export function confirmDisabledReason(items: readonly ReadinessItem[]): string | null {
  if (items.length === 0) return null;
  return `${items.length} ${items.length === 1 ? "item needs" : "items need"} attention before this Agreement can be confirmed.`;
}
