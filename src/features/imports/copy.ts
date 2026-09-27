import type { ImportErrorCategory, ImportOutcomeGroup } from "./types";

// Import Center Completion - human-safe labels only. No internal adapter
// id, classification code, or reason code is ever shown to an actor as a
// PRIMARY label - each is looked up here first.

export const MODULE_LABELS: Record<string, string> = {
  analytics: "Analytics",
  contract_bundle: "Contract bundle (Partner/Vendor + Agreement)",
};

export const MODULE_DESCRIPTIONS: Record<string, string> = {
  analytics: "Campaign/Content posts or Channel/Account snapshots exported from a platform, matched against canonical Content and Partner Account records.",
  contract_bundle: "A bundle of Partner or Vendor records, one Partner Account each, and the Agreement draft to start for them - created through the same canonical services and duplicate checks as the ordinary Agreement-led onboarding screen.",
};

export const OUTCOME_LABELS: Record<ImportOutcomeGroup, string> = {
  CREATE: "Will create",
  UNCHANGED: "Already imported",
  WARNING: "Warning",
  ERROR: "Blocking error",
  AMBIGUOUS: "Needs review",
  QUARANTINED: "Retryable",
  AUTHORIZATION: "Not permitted",
};

export const OUTCOME_TONE: Record<ImportOutcomeGroup, "default" | "orange" | "blue" | "purple" | "red" | "gray"> = {
  CREATE: "blue",
  UNCHANGED: "gray",
  WARNING: "orange",
  ERROR: "red",
  AMBIGUOUS: "purple",
  QUARANTINED: "orange",
  AUTHORIZATION: "red",
};

export const ERROR_CATEGORY_LABELS: Record<ImportErrorCategory, string> = {
  FILE: "File problem",
  STRUCTURE: "Structure problem",
  ROW: "Data problem",
  AUTHORIZATION: "Not permitted",
  SYSTEM: "System error",
};

export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome as ImportOutcomeGroup] ?? outcome;
}

export function outcomeTone(outcome: string) {
  return OUTCOME_TONE[outcome as ImportOutcomeGroup] ?? "gray";
}

export function classificationLabel(classification: string): string {
  const labels: Record<string, string> = {
    ready: "Ready to create",
    matched: "Matched",
    unmatched: "Unmatched",
    warning: "Warning",
    duplicate: "Duplicate of another batch",
    unchanged: "Unchanged (already imported)",
    ambiguous: "Ambiguous match",
    invalid: "Invalid row",
    missing_dependency: "Unrecognized sheet",
    quarantined: "Quarantined (retryable)",
    CREATE: "Will create",
    UNCHANGED: "Already imported",
    AMBIGUOUS: "Needs review",
    ERROR: "Blocking error",
    QUARANTINED: "Retryable",
    AUTHORIZATION: "Not permitted",
  };
  return labels[classification] ?? classification;
}

export function batchStatusLabel(status: string | null | undefined): string {
  const labels: Record<string, string> = {
    PENDING: "In progress",
    DRY_RUN_ONLY: "Reviewed only (not imported)",
    COMPLETED: "Completed",
    COMPLETED_WITH_ERRORS: "Completed with issues",
    FAILED: "Failed",
  };
  return status ? (labels[status] ?? status) : "Not yet run";
}
