// EXECUTE_HARD_RESET Section 13/14: maps existing ACCEPTED backend contracts (AgreementVersionDto,
// ExtractionResultDto, ContractArtifactDto, the FieldViewModel registry projection, AgreementKycStatusDto) into
// the new UI view model. Pure functions only - no JSX, no fetch. Backend DTOs are never altered to fit the UI;
// everything this file cannot represent from the existing contracts is left null/empty rather than invented.
import type { AgreementDocumentDto, ContractArtifactDto, ExtractionResultDto } from "@/server/finance-agreements/client-dto";
import type { AgreementParty, AgreementPartyRole } from "@/server/finance-agreements/types";

import { humanizeExtractionWarning } from "../format";
import type { FieldViewModel } from "../field-view-model";
import { valueLines } from "../agreement-intake-logic/editors/value-lines";
import type { IntakeCounterparty } from "../agreement-intake-logic/intake-context";

import {
  AGREEMENT_CREATE_STEPS,
  type AccountScopeView,
  type AgreementCreateStep,
  type AgreementDocumentView,
  type AgreementPartyRoleView,
  type AgreementPartyView,
  type ContentObligationView,
  type DocumentStorageState,
  type ExtractedFieldView,
  type ExtractionUiState,
  type IncentiveView,
  type KeyClauseView,
  type PerformanceTargetView,
  type ReviewTabKey,
} from "./agreement-create-view";

// --- Review tab grouping (Section 9's tabs - a different taxonomy from the old IntakeSectionId groups) -------------------------------------
const PARTIES_FIELD_KEYS = new Set([
  "counterpartyName", "contactNumber", "emailAddress", "state", "address", "pinCode", "gstin",
  "aadhaarNumber", "aadhaarStatus", "panNumber", "panHolderName", "bankAccountNumber", "ifsc",
  "aadhaarDocumentStatus", "panDocumentStatus", "gstCertificateStatus", "partnerRef", "partnerAccountRefs",
]);
const COMMERCIAL_FIELD_KEYS = new Set(["currency", "paymentCycle", "fixedComponent", "accountTransferFee", "advancePayment", "invoiceRequired", "invoiceDueTerms", "paymentDueTerms", "incentive", "monetisationTerms"]);
const CONTENT_FIELD_KEYS = new Set(["platforms", "collaboratorPageLink", "collaboratorPageName", "monthlyRequiredQualifyingContentCount", "qualifyingUnit", "contentObligations", "lfcSfc", "servicesMandated"]);
const TARGETS_FIELD_KEYS = new Set(["performanceTargets", "performanceEvaluationClause"]);

export function reviewTabOf(fieldKey: string): ReviewTabKey {
  if (PARTIES_FIELD_KEYS.has(fieldKey)) return "parties";
  if (COMMERCIAL_FIELD_KEYS.has(fieldKey)) return "commercial";
  if (CONTENT_FIELD_KEYS.has(fieldKey)) return "content";
  if (TARGETS_FIELD_KEYS.has(fieldKey)) return "targets";
  return "other";
}

// --- Readiness (Confirm step) grouped by wizard step, not by review tab: the Confirm step's "needs attention"
// list should send someone to the STEP that holds the field, and Step 2 (Review & Verify) shows contact/platform
// fields that the review-tab grouping above lumps in with Parties & KYC. A dedicated map keeps the two concerns
// (tab layout on Step 1's Summary vs. step navigation from Step 5) independent.
const STEP2_CONTACT_FIELD_KEYS = new Set(["counterpartyName", "contactNumber", "emailAddress", "state", "address", "pinCode", "platforms", "collaboratorPageLink", "collaboratorPageName"]);
const STEP3_PARTIES_KYC_FIELD_KEYS = new Set(["gstin", "aadhaarNumber", "aadhaarStatus", "panNumber", "panHolderName", "bankAccountNumber", "ifsc", "aadhaarDocumentStatus", "panDocumentStatus", "gstCertificateStatus", "partnerRef", "partnerAccountRefs"]);

export function readinessStepOf(fieldKey: string): AgreementCreateStep {
  if (STEP2_CONTACT_FIELD_KEYS.has(fieldKey)) return 2;
  if (STEP3_PARTIES_KYC_FIELD_KEYS.has(fieldKey)) return 3;
  // Dates/terms, commercial, targets and admin fields all live on Step 4 (Terms & Targets); an unrecognized key
  // defaults there too rather than silently dropping the item.
  return 4;
}

export type ReadinessStepGroup = { step: AgreementCreateStep; title: string; items: ReadonlyArray<{ message: string; anchorId: string }> };

// Groups flat readiness items (one per field, "X needs a decision.") into one row per wizard step, in step order,
// so the Confirm step can show "Terms & Targets - 12 items" instead of 12 near-identical sentences.
export function groupReadinessByStep(items: ReadonlyArray<{ message: string; anchorId: string }>): ReadinessStepGroup[] {
  const byStep = new Map<AgreementCreateStep, Array<{ message: string; anchorId: string }>>();
  for (const item of items) {
    const fieldKey = item.anchorId.replace(/^field-/, "");
    const step = readinessStepOf(fieldKey);
    const bucket = byStep.get(step);
    if (bucket) bucket.push(item);
    else byStep.set(step, [item]);
  }
  return AGREEMENT_CREATE_STEPS.filter((s) => byStep.has(s.step)).map((s) => ({ step: s.step, title: s.title, items: byStep.get(s.step)! }));
}

// --- Extraction state -----------------------------------------------------------------------------------------------------------------
export function extractionUiState(input: { hasArtifact: boolean; phase: "idle" | "uploading" | "extracting"; attached: boolean; runStatus: "EXTRACTED" | "PARTIAL" | "MANUAL_REVIEW_REQUIRED" | null; errored: boolean }): ExtractionUiState {
  if (input.errored) return "error";
  if (input.phase !== "idle") return input.phase;
  if (!input.hasArtifact) return "idle";
  if (!input.attached || !input.runStatus) return "idle";
  if (input.runStatus === "MANUAL_REVIEW_REQUIRED") return "manual_review";
  if (input.runStatus === "PARTIAL") return "partial";
  return "complete";
}

// --- Document -----------------------------------------------------------------------------------------------------------------------
const DOCUMENT_STATUS_MAP: Record<AgreementDocumentDto["status"], DocumentStorageState> = {
  STORED: "STORED",
  PENDING: "PENDING_DURABLE_STORAGE",
  FAILED: "FAILED",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  NOT_APPLICABLE: "NO_NEW_SIGNED_DOCUMENT",
};

export function documentView(input: { artifact: ContractArtifactDto | null; document: AgreementDocumentDto | null; pageCount: number | null; previewUrl: string | null }): AgreementDocumentView | null {
  if (!input.artifact) return null;
  const storageState: DocumentStorageState = input.document ? DOCUMENT_STATUS_MAP[input.document.status] : "LOCAL_ONLY";
  return {
    originalFileName: input.artifact.fileName,
    mimeType: "application/pdf",
    sizeBytes: input.artifact.sizeBytes,
    pageCount: input.pageCount,
    previewUrl: input.previewUrl,
    storageState,
    storageMessage: input.document?.message ?? null,
  };
}

// --- Extracted fields (Summary / per-tab lists) ----------------------------------------------------------------------------------------
export function extractedFieldView(model: FieldViewModel, currency: string | null): ExtractedFieldView {
  const value = model.hasValue ? model.value : model.extractedValue;
  const lines = value !== null && value !== undefined ? valueLines(model.fieldKey, value, { currency }) : [];
  return {
    key: model.fieldKey,
    label: model.label,
    displayValue: lines.length > 0 ? lines.join(" · ") : null,
    confidence: model.provenance?.confidence ?? "UNKNOWN",
    sourcePage: model.provenance?.page ?? null,
    warning: model.needsMapping ? "Needs mapping" : null,
    requiresDecision: model.unresolved || model.needsMapping,
  };
}

// --- Parties (the primary counterparty synthesized as a PRIMARY_COUNTERPARTY row, plus version.parties) ---------------------------------
const ROLE_VIEW_MAP: Record<AgreementPartyRole, AgreementPartyRoleView> = {
  PRIMARY_COUNTERPARTY: "PRIMARY_COUNTERPARTY",
  CO_SERVICE_PROVIDER: "CO_SERVICE_PROVIDER",
  PAYEE: "PAYEE",
  PRESENTER: "PRESENTER",
  SIGNATORY: "SIGNATORY",
  NOTICE_CONTACT: "NOTICE_CONTACT",
  OTHER: "OTHER_CONTRACT_PARTY",
};

export function partyViews(counterparty: IntakeCounterparty | null, parties: readonly AgreementParty[]): AgreementPartyView[] {
  const views: AgreementPartyView[] = [];
  if (counterparty) {
    views.push({ id: "counterparty", name: counterparty.displayName, roles: ["PRIMARY_COUNTERPARTY"], canonicalType: counterparty.type, canonicalRef: counterparty.ref });
  }
  for (const party of parties) {
    const mapping = party.mapping;
    views.push({
      id: party.partyRef,
      name: party.contractName,
      roles: [ROLE_VIEW_MAP[party.role]],
      canonicalType: mapping.kind === "PARTNER" ? "PARTNER" : mapping.kind === "VENDOR" ? "VENDOR" : "UNMAPPED",
      canonicalRef: mapping.kind === "PARTNER" ? mapping.partnerRef : mapping.kind === "VENDOR" ? mapping.vendorRef : null,
    });
  }
  return views;
}

// --- Accounts (Partner-account scope of the primary counterparty only - the only account data the registry carries) -----------------------
export function accountViews(counterparty: IntakeCounterparty | null): AccountScopeView[] {
  if (!counterparty || counterparty.type !== "PARTNER") return [];
  if (counterparty.accountRefs.length === 0) {
    return counterparty.platforms.map((platform, i) => ({ id: `platform-${i}`, platform, displayName: null, handle: null, url: null, partnerAccountRef: null, state: "PARTNER_LEVEL" as const }));
  }
  return counterparty.accountRefs.map((ref, i) => ({
    id: ref,
    platform: counterparty.platforms[i] ?? counterparty.platforms[0] ?? "",
    displayName: null,
    handle: null,
    url: null,
    partnerAccountRef: ref,
    state: "MATCHED" as const,
  }));
}

// --- Content obligations (the repeatable array field; the legacy scalar pair is folded in as one row when the array is empty) --------------
const MAPPING_VALUES = new Set(["APPROVED_CONTENT", "APPROVED_CURRENT_LINK", "LFC", "SFC"]);
function operationalMappingView(raw: string | null): ContentObligationView["operationalMapping"] {
  if (!raw) return "UNMAPPED";
  const upper = raw.trim().toUpperCase().replace(/\s+/g, "_");
  return MAPPING_VALUES.has(upper) ? (upper as ContentObligationView["operationalMapping"]) : "UNMAPPED";
}

export function contentObligationViews(input: { obligations: unknown; scalarCount: number | null; scalarUnit: string | null }): ContentObligationView[] {
  const rows = Array.isArray(input.obligations) ? input.obligations : [];
  if (rows.length > 0) {
    return rows.map((row, i) => {
      const record = row as { obligationRef?: string; label?: string; quantity?: number; period?: string | null; operationalMapping?: string | null };
      return {
        id: record.obligationRef ?? `obligation-${i}`,
        label: record.label ?? "",
        quantity: typeof record.quantity === "number" ? record.quantity : null,
        period: record.period ?? null,
        contractWording: null,
        operationalMapping: operationalMappingView(record.operationalMapping ?? null),
      };
    });
  }
  if (input.scalarCount !== null) {
    return [{ id: "scalar", label: "Qualifying content", quantity: input.scalarCount, period: "Monthly", contractWording: input.scalarUnit, operationalMapping: operationalMappingView(input.scalarUnit) }];
  }
  return [];
}

// --- Incentive -------------------------------------------------------------------------------------------------------------------------
export function incentiveView(value: unknown, decision: "PENDING" | "ACCEPTED" | "CORRECTED" | "UNAVAILABLE" | "NOT_APPLICABLE" | null): IncentiveView {
  const record = value && typeof value === "object" ? (value as { applicable?: boolean; narrative?: string | null; slabs?: unknown[] }) : null;
  if (!record) {
    return { applicable: decision === "PENDING" ? "NEEDS_REVIEW" : "NO", detailMode: "NONE", narrative: null, slabs: [] };
  }
  const slabs = Array.isArray(record.slabs) ? record.slabs : [];
  const applicable: IncentiveView["applicable"] = record.applicable ? "YES" : "NO";
  const detailMode: IncentiveView["detailMode"] = !record.applicable ? "NONE" : slabs.length > 0 ? "STRUCTURED_SLABS" : "NARRATIVE";
  return {
    applicable,
    detailMode,
    narrative: record.narrative ?? null,
    slabs: slabs.map((slab, i) => {
      const s = slab as { slabRef?: string; lowerBound?: number; upperBound?: number | null; amountMinor?: number };
      return { id: s.slabRef ?? `slab-${i}`, start: s.lowerBound ?? null, end: s.upperBound ?? null, amountMinor: s.amountMinor ?? null };
    }),
  };
}

// --- Performance targets -----------------------------------------------------------------------------------------------------------------
export function performanceTargetViews(value: unknown, metricLabel: (metricId: string) => string): PerformanceTargetView[] {
  const rows = Array.isArray(value) ? value : [];
  return rows.map((row, i) => {
    const t = row as { targetRef?: string; metricId?: string; targetValue?: number; unit?: string; comparison?: string; period?: string | null; anchor?: string | null };
    return {
      id: t.targetRef ?? `target-${i}`,
      metricLabel: metricLabel(t.metricId ?? ""),
      operator: t.comparison === "at_least" ? "At least" : null,
      targetDisplay: typeof t.targetValue === "number" ? `${t.targetValue} ${t.unit ?? ""}`.trim() : null,
      periodDisplay: t.period ?? "Period not specified",
      anchorDisplay: t.anchor ?? null,
      consequenceDisplay: "Monitoring only · does not affect payment",
      affectsPayment: false,
    };
  });
}

// --- Key clauses (Summary tab) ------------------------------------------------------------------------------------------------------------
export function keyClauseViews(models: readonly FieldViewModel[], currency: string | null): KeyClauseView[] {
  const KEYS: Array<{ key: string; label: string }> = [
    { key: "servicesMandated", label: "Services mandated" },
    { key: "incentive", label: "Incentive" },
    { key: "performanceTargets", label: "Performance targets" },
    { key: "invoiceDueTerms", label: "Invoice due terms" },
    { key: "paymentDueTerms", label: "Payment due terms" },
    { key: "monetisationTerms", label: "Monetisation / revenue terms" },
  ];
  const byKey = new Map(models.map((m) => [m.fieldKey, m]));
  const rows: KeyClauseView[] = [];
  for (const { key, label } of KEYS) {
    const model = byKey.get(key as FieldViewModel["fieldKey"]);
    if (!model) continue;
    const value = model.hasValue ? model.value : model.extractedValue;
    if (value === null || value === undefined) continue;
    const lines = valueLines(model.fieldKey, value, { currency });
    const full = lines.join(" ");
    rows.push({ key, label, summary: full.length > 220 ? `${full.slice(0, 217)}...` : full, sourcePage: model.provenance?.page ?? null, fullText: full.length > 220 ? full : null });
  }
  return rows;
}

// --- Warnings: humanized, deduplicated, first-seen order preserved (Section 14) ------------------------------------------------------------
export function dedupedWarnings(fieldWarnings: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const codes of fieldWarnings) {
    for (const code of codes) {
      const text = humanizeExtractionWarning(code);
      if (seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

export function extractionWarningsOf(result: Pick<ExtractionResultDto, "fields">): string[] {
  return dedupedWarnings(result.fields.map((field) => field.warnings));
}
