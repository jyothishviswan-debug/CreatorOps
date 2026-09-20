import type { ReviewListSummary, PartnerReviewEventKind, PartnerReviewFreshnessState } from "./types";

// Step 13B: the DTO shapes of the Partner Reviews UI read services. Every one is
// built from stored head `display` projections (or a stored snapshot fallback) -
// counts and labels only. There is no source ref (Assignment / Content / Campaign
// / Analytics record) anywhere in these shapes, no money, and no score.

// --- Permissions (server-computed; the UI only mirrors them) -------------------------
// Each is the actor's explicit Feature + Action grant (no role names, no rank).
// Live Partner Record Scope is still enforced by the server on every call.
export type ReviewActionPermissions = {
  canGenerate: boolean;
  canRefresh: boolean;
  canSubmit: boolean;
  canFinalize: boolean;
  canCreateRevision: boolean;
};

export const NO_REVIEW_PERMISSIONS: ReviewActionPermissions = { canGenerate: false, canRefresh: false, canSubmit: false, canFinalize: false, canCreateRevision: false };

// --- Months ------------------------------------------------------------------------
export type MonthOptionDto = { month: string; label: string };
export type MonthResolutionDto = {
  // The month every figure on the page is for (null = no review month exists yet).
  resolved: string | null;
  label: string | null;
  source: "explicit" | "latest_review" | "latest_candidate" | "none";
  // The caller sent a `month` that is not a real YYYY-MM month (the default was used instead, and says so).
  invalidRequested: boolean;
  options: MonthOptionDto[];
};

// --- List rows -----------------------------------------------------------------------
export type ReviewFreshnessHintDto = { state: PartnerReviewFreshnessState; checkedAt: string };
export type ReviewNeedsReviewReason = "no_review" | "refresh_available" | "revision_available";
export type ReviewRowLifecycle = "NEEDS_REVIEW" | "DRAFT" | "IN_REVIEW" | "FINALIZED";

export type ReviewListRowDto = {
  rowKey: string;
  // "review" = a stored head; "candidate" = a Partner-month with in-period evidence but no head yet.
  kind: "review" | "candidate";
  partnerRef: string;
  partnerDisplayName: string | null;
  periodKey: string;
  reviewRef: string | null;
  // The head's current (default) version: open, else current finalized, else newest.
  version: number | null;
  lifecycle: ReviewRowLifecycle;
  needsReviewReason: ReviewNeedsReviewReason | null;
  // An open Draft/In Review version exists while an earlier version is still the current finalized one.
  revisionOpen: boolean;
  currentFinalizedVersion: number | null;
  finalizedAt: string | null;
  revisionCount: number;
  // "As of <date>" - best-effort, never live. null = never recorded.
  freshnessHint: ReviewFreshnessHintDto | null;
  summary: ReviewListSummary | null;
  summarySource: "stored" | "derived_from_snapshot" | "unavailable";
  lastEvent: { kind: PartnerReviewEventKind; at: string; supersededVersion: number | null } | null;
  // Candidates only: how many Assignments of that month the bounded scan found.
  assignmentsFound: number | null;
};

export type ReviewScanDisclosureDto = {
  // Reviews read for the page/aggregate, and whether the bounded read stopped early.
  headsRead: number;
  headsTruncated: boolean;
  // The bounded Assignment scan behind Needs Review candidates (null = not run for this view).
  assignmentsScanned: number | null;
  assignmentScanTruncated: boolean;
  scanLimit: number;
};
