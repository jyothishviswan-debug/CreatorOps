import type { PartnerDoc } from "@/server/partners/types";

import type { CandidateGroup } from "./needs-review-candidates";
import type { ResolvedDisplay } from "./review-scan";
import type { PartnerReviewFreshnessState, PartnerReviewHeadDoc } from "./types";
import type { ReviewFreshnessHintDto, ReviewListRowDto, ReviewNeedsReviewReason } from "./ui-dto";
import type { WorkspaceSignal } from "./ui-params";

// Step 13B: the PURE builders of list rows from stored head projections. Nothing
// here reads anything or knows an actor: authorization and scope happen before a
// head ever reaches these functions.

// The two states that mean "the recorded snapshot is behind upstream". Read from
// the head's best-effort freshness hint (never computed here) - so "stale" at list
// level always means "based on the last recorded check", never live, and no
// staleness time threshold is invented.
export function isStaleHintState(state: PartnerReviewFreshnessState | null | undefined): boolean {
  return state === "refresh_available" || state === "revision_available";
}

export function needsReviewReasonOf(hint: ReviewFreshnessHintDto | null): ReviewNeedsReviewReason | null {
  if (hint?.state === "refresh_available") return "refresh_available";
  if (hint?.state === "revision_available") return "revision_available";
  return null;
}

export function buildReviewRow(head: PartnerReviewHeadDoc, resolved: ResolvedDisplay | undefined, partnerDisplayName: string | null): ReviewListRowDto {
  const display = resolved?.display ?? null;
  const hint: ReviewFreshnessHintDto | null = head.freshnessHint ? { state: head.freshnessHint.state, checkedAt: head.freshnessHint.checkedAt } : null;
  // The head's default version decides the row's lifecycle: an open version (Draft / In Review) wins,
  // else the current finalized version. A SUPERSEDED version is never a head's default.
  const status = display?.status ?? (head.openVersion !== null ? head.latestStatus : head.currentFinalizedVersion !== null ? "FINALIZED" : head.latestStatus);
  const lifecycle: "DRAFT" | "IN_REVIEW" | "FINALIZED" = status === "IN_REVIEW" ? "IN_REVIEW" : status === "DRAFT" ? "DRAFT" : "FINALIZED";
  return {
    rowKey: `${head.partnerRef}|${head.periodKey}`,
    kind: "review",
    partnerRef: head.partnerRef,
    partnerDisplayName,
    periodKey: head.periodKey,
    reviewRef: head.reviewRef,
    version: display?.version ?? head.openVersion ?? head.currentFinalizedVersion ?? head.latestVersion,
    lifecycle,
    needsReviewReason: needsReviewReasonOf(hint),
    revisionOpen: head.openVersion !== null && head.currentFinalizedVersion !== null,
    currentFinalizedVersion: head.currentFinalizedVersion,
    finalizedAt: display?.finalizedAt ?? null,
    revisionCount: Math.max(0, head.latestVersion - 1),
    freshnessHint: hint,
    summary: display?.summary ?? null,
    summarySource: resolved?.source ?? "unavailable",
    lastEvent: display ? { kind: display.lastEventKind, at: display.lastEventAt, supersededVersion: display.supersededVersion } : null,
    assignmentsFound: null,
  };
}

export function buildCandidateRow(group: CandidateGroup, partner: Pick<PartnerDoc, "displayName">): ReviewListRowDto {
  return {
    rowKey: `${group.partnerRef}|${group.periodKey}`,
    kind: "candidate",
    partnerRef: group.partnerRef,
    partnerDisplayName: partner.displayName,
    periodKey: group.periodKey,
    reviewRef: null,
    version: null,
    lifecycle: "NEEDS_REVIEW",
    needsReviewReason: "no_review",
    revisionOpen: false,
    currentFinalizedVersion: null,
    finalizedAt: null,
    revisionCount: 0,
    freshnessHint: null,
    summary: null,
    summarySource: "unavailable",
    lastEvent: null,
    assignmentsFound: group.assignments,
  };
}

// Membership of a review row in a Needs Attention signal. Uses ONLY the stored
// summary and the recorded freshness hint; a candidate (no review yet) never
// matches a signal.
export function rowMatchesSignal(row: ReviewListRowDto, signal: WorkspaceSignal): boolean {
  if (row.kind !== "review") return false;
  const summary = row.summary;
  switch (signal) {
    case "stale":
      return row.freshnessHint?.state === "refresh_available";
    case "revision_available":
      return row.freshnessHint?.state === "revision_available";
    case "missing_evidence":
      return summary?.performance.state === "missing";
    case "late":
      return (summary?.compliance.late ?? 0) > 0;
    case "target_not_met":
      return (summary?.commercial.targets.notMet ?? 0) > 0;
    case "requirement_unavailable":
      return summary !== null && summary.commercial.governing !== null && summary.commercial.deliverable.evaluation === "unavailable";
    case "lfc_sfc_unavailable":
      return summary !== null && summary.commercial.governing !== null && summary.commercial.lfcSfc.status === "unavailable";
  }
}
