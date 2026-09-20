import type { ReviewListRowDto } from "./ui-dto";
import { isStaleHintState } from "./review-rows";

// Step 13B: the PURE aggregation behind the Partner Reviews Overview. It counts
// stored list projections (row summaries + recorded freshness hints) - it never
// reads anything, never runs the collector, computes no score and no money.
//
// Semantics, exactly (each is asserted by a unit test):
//   Monthly reviews      heads in the selected month
//   Assignments received sum of summary.production.assignmentsIncluded
//   Qualifying content   per review: the policy-counted actual when the review
//                        carries one, else the provable approved-Content count
//   Finalized reviews    heads with a current finalized version
//   Timeliness           On time / Late from stored booleans; unknown timing is
//                        disclosed separately and is NEVER counted as late
//   Performance evidence a PARTITION of the month's reviews: Missing (no in-period
//                        Analytics record in the snapshot), else Stale (the LAST
//                        RECORDED freshness check said refresh/revision available),
//                        else Available. "Stale" is therefore "based on last check",
//                        never live.
//   Review lifecycle     an EXCLUSIVE partition: Needs review (Partner-months with
//                        no review yet + reviews whose recorded check says they are
//                        behind upstream), else Draft / in review (open version),
//                        else Finalized.

export type OverviewCounts = {
  monthlyReviews: number;
  finalizedReviews: number;
  assignmentsReceived: number;
  // Reviews whose stored summary could not be read (legacy head over the fallback cap): excluded from every sum below.
  summaryUnavailableReviews: number;
  qualifyingContent: number;
  // Sum of policy-supplied monthly requirements, and how many reviews supplied one.
  requiredTotal: number;
  reviewsWithRequirement: number;
  production: { underReview: number; approved: number; completedAssignments: number };
  timeliness: { onTime: number; late: number; unknownTiming: number };
  performance: { available: number; stale: number; missing: number };
  lifecycle: { needsReview: number; draftInReview: number; finalized: number };
  candidates: number;
  attention: {
    staleEvidence: number;
    revisionAvailable: number;
    missingEvidence: number;
    lateSubmissions: number;
    draftReviews: number;
    requirementUnavailable: number;
    lfcSfcUnavailable: number;
    targetNotMet: number;
  };
};

export function aggregateOverview(reviewRows: readonly ReviewListRowDto[], candidateCount: number): OverviewCounts {
  const counts: OverviewCounts = {
    monthlyReviews: reviewRows.length,
    finalizedReviews: 0,
    assignmentsReceived: 0,
    summaryUnavailableReviews: 0,
    qualifyingContent: 0,
    requiredTotal: 0,
    reviewsWithRequirement: 0,
    production: { underReview: 0, approved: 0, completedAssignments: 0 },
    timeliness: { onTime: 0, late: 0, unknownTiming: 0 },
    performance: { available: 0, stale: 0, missing: 0 },
    lifecycle: { needsReview: candidateCount, draftInReview: 0, finalized: 0 },
    candidates: candidateCount,
    attention: { staleEvidence: 0, revisionAvailable: 0, missingEvidence: 0, lateSubmissions: 0, draftReviews: 0, requirementUnavailable: 0, lfcSfcUnavailable: 0, targetNotMet: 0 },
  };

  for (const row of reviewRows) {
    if (row.currentFinalizedVersion !== null) counts.finalizedReviews += 1;

    const hinted = isStaleHintState(row.freshnessHint?.state);
    const open = row.lifecycle === "DRAFT" || row.lifecycle === "IN_REVIEW";
    if (hinted) counts.lifecycle.needsReview += 1;
    else if (open) counts.lifecycle.draftInReview += 1;
    else counts.lifecycle.finalized += 1;

    if (row.freshnessHint?.state === "refresh_available") counts.attention.staleEvidence += 1;
    if (row.freshnessHint?.state === "revision_available") counts.attention.revisionAvailable += 1;
    if (open) counts.attention.draftReviews += 1;

    const summary = row.summary;
    if (!summary) {
      counts.summaryUnavailableReviews += 1;
      continue;
    }

    counts.assignmentsReceived += summary.production.assignmentsIncluded;
    counts.production.underReview += summary.production.underReviewContent;
    counts.production.approved += summary.production.approvedContent;
    counts.production.completedAssignments += summary.production.completedAssignments;

    counts.qualifyingContent += summary.commercial.deliverable.actual ?? summary.production.approvedContent;
    if (summary.commercial.deliverable.required !== null) {
      counts.requiredTotal += summary.commercial.deliverable.required;
      counts.reviewsWithRequirement += 1;
    }

    counts.timeliness.onTime += summary.compliance.onTime;
    counts.timeliness.late += summary.compliance.late;
    counts.timeliness.unknownTiming += summary.compliance.unknownTiming;
    counts.attention.lateSubmissions += summary.compliance.late;

    if (summary.performance.state === "missing") {
      counts.performance.missing += 1;
      counts.attention.missingEvidence += 1;
    } else if (hinted) counts.performance.stale += 1;
    else counts.performance.available += 1;

    if (summary.commercial.governing !== null && summary.commercial.deliverable.evaluation === "unavailable") counts.attention.requirementUnavailable += 1;
    if (summary.commercial.governing !== null && summary.commercial.lfcSfc.status === "unavailable") counts.attention.lfcSfcUnavailable += 1;
    counts.attention.targetNotMet += summary.commercial.targets.notMet;
  }
  return counts;
}

export type RecentActivityRow = { kind: "generated" | "refreshed" | "submitted" | "finalized" | "revision_created" | "superseded"; partnerDisplayName: string | null; at: string; reviewRef: string };

export const RECENT_ACTIVITY_LIMIT = 6;

// Newest first, at most RECENT_ACTIVITY_LIMIT rows, from the LAST event recorded on each review's
// display block. A finalize that superseded an older version also yields a "superseded" row (same
// instant) - the only other kind provable from stored head data without reading events.
export function buildRecentActivity(reviewRows: readonly ReviewListRowDto[], limit = RECENT_ACTIVITY_LIMIT): RecentActivityRow[] {
  const rows: RecentActivityRow[] = [];
  for (const row of reviewRows) {
    if (!row.lastEvent || !row.reviewRef) continue;
    rows.push({ kind: row.lastEvent.kind, partnerDisplayName: row.partnerDisplayName, at: row.lastEvent.at, reviewRef: row.reviewRef });
    if (row.lastEvent.kind === "finalized" && row.lastEvent.supersededVersion !== null) rows.push({ kind: "superseded", partnerDisplayName: row.partnerDisplayName, at: row.lastEvent.at, reviewRef: row.reviewRef });
  }
  // Newest first; ties broken so "finalized" reads before its own "superseded" companion; then by reviewRef for determinism.
  const order = (kind: RecentActivityRow["kind"]) => (kind === "superseded" ? 1 : 0);
  rows.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : order(a.kind) !== order(b.kind) ? order(a.kind) - order(b.kind) : a.reviewRef < b.reviewRef ? -1 : 1));
  return rows.slice(0, limit);
}
