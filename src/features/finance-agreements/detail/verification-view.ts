import type { AgreementVersionDto } from "@/server/finance-agreements/client-dto";
import { AGREEMENT_FIELDS, AGREEMENT_FIELD_BY_KEY, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { ReconciliationState } from "@/server/finance-agreements/reconciliation-compare";
import type { AgreementReconciliationDto } from "@/server/finance-agreements/reconciliation-service";

import { buildCrossVerificationRows } from "../cross-verification";
import { confirmedFieldValue, formatFieldValue } from "../field-values";
import { NO_VALUE_TEXT, decisionChip, fieldLabel, formatInstant, originLabel, reconciliationChip, type ChipSpec, type PillTone } from "../format";

// Step 14B: the Verification tab's two read-only views (pure).
//   1. FROZEN provenance: per decided field, who decided what, where the value came from (Agreement / master data / manual), at what
//      confidence and page - copied into the version when it was confirmed. It never changes afterwards, whatever happens to the
//      Partner / Vendor record later (a confirmed version is immutable history).
//   2. the LIVE comparison of the version with CreatorOps master data (the reconciliation read). Informational: reading it changes nothing.
// Identity values (PAN, Aadhaar, GSTIN, bank ...) are NEVER printed by either view: an identity field shows a status only.
export const IDENTITY_NOT_STORED_TEXT = "Not stored in the Agreement";

export type ProvenanceRow = {
  fieldKey: AgreementFieldKey;
  label: string;
  decision: ChipSpec;
  // "CreatorOps master data" / "Agreement" / "Manual".
  source: string;
  // "Agreement · page 3 · Confidence: High" - the frozen provenance label, page and confidence.
  provenance: string;
  // The frozen confirmed value as text (never an identity value).
  value: string;
  decidedAt: string;
  decidedBy: string | null;
};

const CONFIDENCE_TEXT: Record<string, string> = { HIGH: "High", MEDIUM: "Medium", LOW: "Low", UNKNOWN: "Unknown" };

export function provenanceText(entry: { provenance: { label: string; page: number | null; confidence: string | null } }): string {
  const parts = [entry.provenance.label];
  if (entry.provenance.page !== null) parts.push(`page ${entry.provenance.page}`);
  if (entry.provenance.confidence !== null) parts.push(`Confidence: ${CONFIDENCE_TEXT[entry.provenance.confidence] ?? entry.provenance.confidence}`);
  return parts.join(" · ");
}

function frozenValueText(key: AgreementFieldKey, decision: string, version: Pick<AgreementVersionDto, "terms" | "contactSnapshot">): string {
  if (AGREEMENT_FIELD_BY_KEY[key].identityValue) return IDENTITY_NOT_STORED_TEXT;
  if (decision === "UNAVAILABLE") return "Unavailable";
  if (decision === "NOT_APPLICABLE") return "Not applicable";
  const currency = version.terms?.commercial.currency ?? null;
  return formatFieldValue(key, confirmedFieldValue(key, version.terms, version.contactSnapshot), { currency });
}

// One row per frozen field, in registry order. Empty for a version that has no frozen provenance (an unconfirmed draft).
export function buildProvenanceRows(version: Pick<AgreementVersionDto, "fieldProvenance" | "terms" | "contactSnapshot">): ProvenanceRow[] {
  const frozen = version.fieldProvenance;
  if (!frozen) return [];
  const rows: ProvenanceRow[] = [];
  for (const field of AGREEMENT_FIELDS) {
    const entry = frozen[field.key];
    if (!entry) continue;
    rows.push({
      fieldKey: field.key,
      label: fieldLabel(field.key),
      decision: decisionChip(entry.decision),
      source: originLabel(entry.origin),
      provenance: provenanceText(entry),
      value: frozenValueText(field.key, entry.decision, version),
      decidedAt: entry.decidedAt ? formatInstant(entry.decidedAt) : NO_VALUE_TEXT,
      decidedBy: entry.decidedByUserRef,
    });
  }
  return rows;
}

export type ComparisonRow = {
  fieldKey: AgreementFieldKey;
  label: string;
  state: ReconciliationState;
  stateChip: ChipSpec;
  reason: string | null;
  creatorOpsText: string;
  agreementText: string;
  highlight: boolean;
  identity: boolean;
};

// The live comparison, read-only (no action of any kind). Identity values arrive already masked (last four characters) from the shared row builder; a restricted row reads Restricted.
export function buildComparisonRows(reconciliation: Pick<AgreementReconciliationDto, "fields" | "versionConfirmed" | "versionStatus">): ComparisonRow[] {
  return buildCrossVerificationRows(reconciliation, { canManage: false }).map((row) => {
    const identity = AGREEMENT_FIELD_BY_KEY[row.fieldKey].identityValue;
    return {
      fieldKey: row.fieldKey,
      label: row.label,
      state: row.state,
      stateChip: row.stateChip,
      reason: row.reasonText,
      creatorOpsText: row.creatorOpsText,
      agreementText: row.agreementText,
      highlight: row.highlight,
      identity,
    };
  });
}

const SUMMARY_ORDER: readonly ReconciliationState[] = ["MATCH", "MISMATCH", "MISSING_IN_CREATOROPS", "MISSING_IN_AGREEMENT", "UNAVAILABLE", "RESTRICTED", "NOT_APPLICABLE"];

export type SummaryChip = { state: ReconciliationState; label: string; count: number; tone: PillTone };

// "Match 6", "Mismatch 1" ... only the states that occur, in a fixed order. The text carries the meaning; the tone only supports it.
export function reconciliationSummaryChips(summary: Partial<Record<ReconciliationState, number>>): SummaryChip[] {
  return SUMMARY_ORDER.filter((state) => (summary[state] ?? 0) > 0).map((state) => {
    const chip = reconciliationChip(state);
    return { state, label: chip.label, count: summary[state] ?? 0, tone: chip.tone };
  });
}

// Differences that still need a person's attention (mismatch or one-sided values), for the Overview summary line.
export function reconciliationAttentionCount(summary: Partial<Record<ReconciliationState, number>>): number {
  return (summary.MISMATCH ?? 0) + (summary.MISSING_IN_CREATOROPS ?? 0) + (summary.MISSING_IN_AGREEMENT ?? 0);
}
