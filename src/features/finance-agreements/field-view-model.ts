import { AGREEMENT_FIELDS, AGREEMENT_FIELD_BY_KEY, type AgreementFieldGroup, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { AgreementDraftEntryDto, ExtractionResultDto } from "@/server/finance-agreements/client-dto";
import type { AgreementEntryDecision, AgreementFieldOrigin, CounterpartyType, ExtractionConfidence } from "@/server/finance-agreements/types";

import { decisionStateChip } from "./components/field-decision-logic";
import { fieldLabel, NEEDS_CONFIRMATION_LABEL, NEEDS_MAPPING_LABEL, RESTRICTED_VALUE_TEXT, type ChipSpec } from "./format";
import { formatFieldValue } from "./field-values";
import { isIdentityField, maskIdentityInText, maskIdentityValue } from "./identity-mask";
import { mapQualifyingUnit } from "./qualifying-unit";

// Step 14B: registry + draft entries -> a per-field VIEW MODEL grouped by the intake sections (pure).
// The registry (AGREEMENT_FIELDS) is the single source of truth: labels, whether a field is decidable, restricted,
// required or applicable come from it; the only thing decided here is which intake section shows a field and
// which editor it gets.

// The intake sections that own field editors (the ten sections of the staged form, minus the ones that show no field
// editors of their own: Agreement for, Contract source, Existing CreatorOps details, Extracted from Agreement, Review).
//   agreement_for        the computed counterparty refs (partnerRef, partnerAccountRefs) - display only
//   cross_verification   contact + platform fields the reconciliation compares against CreatorOps master data
//   commercial_terms     dates & clauses ("dates" subsection) and the payment-affecting terms ("commercial" subsection)
//   performance_targets  the warning-only targets
//   kyc                  identity VALUES (acknowledgement only) and the computed KYC statuses
//   additional_details   onboarding flag, remarks, and the derived Agreement type
export type IntakeSectionId = "agreement_for" | "cross_verification" | "commercial_terms" | "performance_targets" | "kyc" | "additional_details";
export type IntakeSubsection = "counterparty" | "contact" | "platform" | "dates" | "commercial" | "targets" | "identity" | "status" | "admin";

export const INTAKE_SECTION_LABELS: Record<IntakeSectionId, string> = {
  agreement_for: "Agreement for",
  cross_verification: "Cross-verification",
  commercial_terms: "Commercial terms",
  performance_targets: "Performance targets",
  kyc: "KYC & restricted details",
  additional_details: "Additional details",
};

export const SUBSECTION_LABELS: Record<IntakeSubsection, string> = {
  counterparty: "Counterparty",
  contact: "Contact details",
  platform: "Platform & page",
  dates: "Agreement dates & clauses",
  commercial: "Payment-affecting terms",
  targets: "Performance targets",
  identity: "Restricted identity",
  status: "KYC status",
  admin: "Additional details",
};

const GROUP_PLACEMENT: Record<AgreementFieldGroup, { section: IntakeSectionId; subsection: IntakeSubsection }> = {
  counterparty_contact: { section: "cross_verification", subsection: "contact" },
  partner_platform: { section: "cross_verification", subsection: "platform" },
  dates_terms: { section: "commercial_terms", subsection: "dates" },
  commercial: { section: "commercial_terms", subsection: "commercial" },
  targets: { section: "performance_targets", subsection: "targets" },
  identity: { section: "kyc", subsection: "identity" },
  admin: { section: "additional_details", subsection: "admin" },
};

// Field-level placements that differ from their group's.
const PLACEMENT_OVERRIDES: Partial<Record<AgreementFieldKey, { section: IntakeSectionId; subsection: IntakeSubsection }>> = {
  partnerRef: { section: "agreement_for", subsection: "counterparty" },
  partnerAccountRefs: { section: "agreement_for", subsection: "counterparty" },
  gstin: { section: "kyc", subsection: "identity" },
  aadhaarStatus: { section: "kyc", subsection: "status" },
  aadhaarDocumentStatus: { section: "kyc", subsection: "status" },
  panDocumentStatus: { section: "kyc", subsection: "status" },
  gstCertificateStatus: { section: "kyc", subsection: "status" },
};

export function fieldPlacement(key: AgreementFieldKey): { section: IntakeSectionId; subsection: IntakeSubsection } {
  return PLACEMENT_OVERRIDES[key] ?? GROUP_PLACEMENT[AGREEMENT_FIELD_BY_KEY[key].group];
}

// --- Editor kinds --------------------------------------------------------------------------------------------------------------------------
export type FieldEditorKind =
  | "text"
  | "longText"
  | "date"
  | "currency"
  | "paymentCycle"
  | "count"
  | "qualifyingUnit"
  | "boolean"
  | "platforms"
  | "fixedComponent"
  | "accountTransferFee"
  | "advancePayment"
  | "incentive"
  | "lfcSfc"
  | "performanceTargets"
  // identity VALUE: an acknowledgement only, never a value editor
  | "acknowledge"
  // system-supplied (agreementType, partnerRef, partnerAccountRefs, the KYC statuses): read-only
  | "computed";

const LONG_TEXT_FIELDS: ReadonlySet<AgreementFieldKey> = new Set<AgreementFieldKey>(["renewalTerms", "noticeTerms", "terminationTerms", "invoiceDueTerms", "paymentDueTerms", "servicesMandated", "remarks"]);
const SPECIAL_EDITORS: Partial<Record<AgreementFieldKey, FieldEditorKind>> = {
  currency: "currency",
  paymentCycle: "paymentCycle",
  monthlyRequiredQualifyingContentCount: "count",
  qualifyingUnit: "qualifyingUnit",
  invoiceRequired: "boolean",
  onboardingProcessCompleted: "boolean",
  platforms: "platforms",
  fixedComponent: "fixedComponent",
  accountTransferFee: "accountTransferFee",
  advancePayment: "advancePayment",
  incentive: "incentive",
  lfcSfc: "lfcSfc",
  performanceTargets: "performanceTargets",
  signedDate: "date",
  effectiveDate: "date",
  terminationDate: "date",
};

export function editorKindFor(key: AgreementFieldKey): FieldEditorKind {
  const field = AGREEMENT_FIELD_BY_KEY[key];
  if (field.mode !== "DECIDED") return "computed";
  if (field.identityValue) return "acknowledge";
  if (LONG_TEXT_FIELDS.has(key)) return "longText";
  return SPECIAL_EDITORS[key] ?? "text";
}

// --- The view model -------------------------------------------------------------------------------------------------------------------------
export type FieldProvenanceView = { label: string; page: number | null; confidence: ExtractionConfidence | null; extractionRunRef: string | null };

export type FieldViewModel = {
  fieldKey: AgreementFieldKey;
  label: string;
  group: AgreementFieldGroup;
  section: IntakeSectionId;
  subsection: IntakeSubsection;
  editorKind: FieldEditorKind;
  // A human decides it (false for the computed fields).
  decidable: boolean;
  restricted: boolean;
  identityValue: boolean;
  requiredForConfirm: "always" | "conditional" | "never";
  requiredWhen: string | null;
  explicitDecisionRequired: boolean;
  // The draft entry, if any.
  hasEntry: boolean;
  decision: AgreementEntryDecision | null;
  origin: AgreementFieldOrigin | null;
  // The candidate value. Always null for an identity VALUE (an Agreement never holds one).
  value: unknown;
  hasValue: boolean;
  extractedValue: unknown;
  displayValue: string;
  extractedDisplayValue: string | null;
  provenance: FieldProvenanceView | null;
  // Awaiting a human decision: a PENDING proposal / prefill, or no entry at all for a field that must be decided deliberately.
  unresolved: boolean;
  // qualifyingUnit only: the value or the extractor's wording is not one of the two supported units.
  needsMapping: boolean;
  // Decided by a human (ACCEPTED / CORRECTED / UNAVAILABLE / NOT_APPLICABLE). A PENDING extracted value is NOT accepted.
  decided: boolean;
  statusChip: ChipSpec;
  // The visible provenance / source text ("CreatorOps master data", "Agreement · page 3", "Manual", ...).
  sourceText: string | null;
};

function sourceTextOf(origin: AgreementFieldOrigin | null, provenance: FieldProvenanceView | null): string | null {
  if (!origin) return null;
  if (origin === "MASTER_DATA") return "CreatorOps master data";
  if (origin === "EXTRACTED") return provenance?.page ? `Agreement · page ${provenance.page}` : "Agreement";
  return "Manual";
}

// The value context for money formatting: the draft's decided currency, if any.
function currencyOf(draft: Partial<Record<AgreementFieldKey, AgreementDraftEntryDto>>): string | null {
  const entry = draft.currency;
  return entry && (entry.decision === "ACCEPTED" || entry.decision === "CORRECTED") && typeof entry.value === "string" ? entry.value : null;
}

export type BuildFieldViewModelsInput = {
  draft: Partial<Record<AgreementFieldKey, AgreementDraftEntryDto>>;
  counterpartyType: CounterpartyType;
  // Include fields that do not apply to this counterparty type (e.g. Aadhaar for a Vendor). Default false.
  includeNotApplicable?: boolean;
};

// One view model per registry field, in registry order. A field that does not apply to the counterparty type is dropped
// (an Aadhaar row for a Vendor) unless includeNotApplicable.
export function buildFieldViewModels(input: BuildFieldViewModelsInput): FieldViewModel[] {
  const currency = currencyOf(input.draft);
  const models: FieldViewModel[] = [];
  for (const field of AGREEMENT_FIELDS) {
    if (!field.appliesTo.includes(input.counterpartyType) && !input.includeNotApplicable) continue;
    const entry = input.draft[field.key] ?? null;
    const decidable = field.mode === "DECIDED";
    const value = field.identityValue ? null : (entry?.value ?? null);
    const extractedValue = field.identityValue ? null : (entry?.extractedValue ?? null);
    const decision = entry?.decision ?? null;
    const provenance: FieldProvenanceView | null = entry ? { label: entry.provenance.label, page: entry.provenance.page, confidence: entry.provenance.confidence, extractionRunRef: entry.provenance.extractionRunRef } : null;
    // The CURRENT value decides: once the person has chosen a supported unit the extractor's wording (kept as a note beside it) no longer needs mapping.
    const needsMapping = field.key === "qualifyingUnit" && mapQualifyingUnit(value !== null ? value : extractedValue).state === "NEEDS_MAPPING";
    const unresolved = decidable && field.appliesTo.includes(input.counterpartyType) && (entry ? decision === "PENDING" : field.explicitDecisionRequired);
    const placement = fieldPlacement(field.key);
    models.push({
      fieldKey: field.key,
      label: fieldLabel(field.key),
      group: field.group,
      section: placement.section,
      subsection: placement.subsection,
      editorKind: editorKindFor(field.key),
      decidable,
      restricted: field.restricted,
      identityValue: field.identityValue,
      requiredForConfirm: field.requiredForConfirm,
      requiredWhen: field.requiredWhen,
      explicitDecisionRequired: field.explicitDecisionRequired,
      hasEntry: entry !== null,
      decision,
      origin: entry?.origin ?? null,
      value,
      hasValue: value !== null && value !== undefined,
      extractedValue,
      displayValue: formatFieldValue(field.key, value, { currency }),
      extractedDisplayValue: extractedValue === null ? null : formatFieldValue(field.key, extractedValue, { currency }),
      provenance,
      unresolved,
      needsMapping,
      decided: decision !== null && decision !== "PENDING",
      statusChip: decisionStateChip(decision, { explicitDecisionRequired: field.explicitDecisionRequired }),
      sourceText: sourceTextOf(entry?.origin ?? null, provenance),
    });
  }
  return models;
}

// Group by intake section, keeping registry order inside each.
export function groupFieldViewModels(models: readonly FieldViewModel[]): Record<IntakeSectionId, FieldViewModel[]> {
  const groups: Record<IntakeSectionId, FieldViewModel[]> = { agreement_for: [], cross_verification: [], commercial_terms: [], performance_targets: [], kyc: [], additional_details: [] };
  for (const model of models) groups[model.section].push(model);
  return groups;
}

export function fieldsInSubsection(models: readonly FieldViewModel[], subsection: IntakeSubsection): FieldViewModel[] {
  return models.filter((model) => model.subsection === subsection);
}

export function unresolvedFields(models: readonly FieldViewModel[]): FieldViewModel[] {
  return models.filter((model) => model.unresolved);
}
export const unresolvedCount = (models: readonly FieldViewModel[]): number => unresolvedFields(models).length;

// --- Extraction review rows (section 4: "Extracted from Agreement") ------------------------------------------------------------------------------
export type ExtractionRowView = {
  fieldKey: AgreementFieldKey;
  label: string;
  // The proposed value as text. An identity value the actor may not see is masked; it is never anything else.
  valueText: string;
  restricted: boolean;
  confidence: ExtractionConfidence;
  page: number | null;
  warnings: string[];
  hasWarnings: boolean;
  // Always true: an extracted value is a proposal until a human decides it.
  needsConfirmation: true;
  needsConfirmationLabel: string;
  // qualifyingUnit only.
  needsMapping: boolean;
  needsMappingLabel: string | null;
  // Raw contract snippet - present ONLY when the actor may see contract detail (and the snippet itself is visible).
  snippet: string | null;
};

function maskedSnippet(snippet: string | undefined): string | null {
  return snippet === undefined ? null : maskIdentityInText(snippet);
}

export function buildExtractionRows(result: Pick<ExtractionResultDto, "fields" | "contractDetailVisible" | "restricted">): ExtractionRowView[] {
  const snippets = new Map<string, string>();
  if (result.contractDetailVisible && result.restricted) {
    for (const snippet of result.restricted.snippets) if (snippet.snippetState === "VISIBLE" && snippet.rawSnippet !== null) snippets.set(snippet.fieldKey, snippet.rawSnippet);
  }
  return result.fields.map((field) => {
    const restricted = field.valueState === "RESTRICTED";
    const needsMapping = !restricted && field.fieldKey === "qualifyingUnit" && mapQualifyingUnit(field.normalizedValue).state === "NEEDS_MAPPING";
    return {
      fieldKey: field.fieldKey,
      label: fieldLabel(field.fieldKey),
      // An identity value the actor may see is still only ever shown masked (last four characters).
      valueText: restricted ? RESTRICTED_VALUE_TEXT : isIdentityField(field.fieldKey) ? maskIdentityValue(field.fieldKey, field.normalizedValue) : formatFieldValue(field.fieldKey, field.normalizedValue),
      restricted,
      confidence: field.confidence,
      page: field.page,
      warnings: [...field.warnings],
      hasWarnings: field.warnings.length > 0,
      needsConfirmation: true,
      needsConfirmationLabel: NEEDS_CONFIRMATION_LABEL,
      needsMapping,
      needsMappingLabel: needsMapping ? NEEDS_MAPPING_LABEL : null,
      // Raw contract text (contract access only) never prints a full identity number: identity-shaped tokens in it are masked.
      snippet: restricted ? null : maskedSnippet(snippets.get(field.fieldKey)),
    };
  });
}
