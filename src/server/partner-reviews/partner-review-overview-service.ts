import type { ActorContext } from "@/server/authz/types";

import { aggregateOverview, buildRecentActivity, type OverviewCounts, type RecentActivityRow } from "./overview-aggregate";
import { getReviewActionPermissions } from "./partner-review-permissions";
import { requirePartnerReviewsFeatureAccess } from "./partner-reviews-gate";
import { buildReviewRow } from "./review-rows";
import { HEAD_SCAN_CEILING, resolveDisplays, scanHeads, verifyLiveScope, CANDIDATE_SCAN_CEILING } from "./review-scan";
import { loadViewContext } from "./review-view-context";
import { partnerReviewsUnauthorizedResult, type PartnerReviewsServiceResult } from "./types";
import type { MonthResolutionDto, ReviewActionPermissions, ReviewListRowDto, ReviewScanDisclosureDto } from "./ui-dto";
import { type MonthParam } from "./ui-params";

// Step 13B: the trusted read behind the Partner Reviews Overview.
//
// Trust chain, in order (each step fails closed): the `partner_reviews` feature
// (explicit grant) -> the actor's scope grants read ONCE -> a bounded, scope-first
// head scan (heads only - never a version document for a stored-display head, never
// the evidence collector) -> every head's LIVE Partner re-verified (one bulk read)
// -> counts aggregated from stored list projections. See overview-aggregate.ts for
// the exact meaning of each figure and review-view-context.ts for the month rule.

export type PartnerReviewsOverviewDto = {
  month: MonthResolutionDto;
  counts: OverviewCounts;
  activity: RecentActivityRow[];
  permissions: ReviewActionPermissions;
  disclosure: ReviewScanDisclosureDto;
};

export async function getPartnerReviewsOverview(actor: ActorContext | null, requested: MonthParam): Promise<PartnerReviewsServiceResult<PartnerReviewsOverviewDto>> {
  const gate = await requirePartnerReviewsFeatureAccess(actor);
  if (!gate.ok) return partnerReviewsUnauthorizedResult(gate.reason);

  const context = await loadViewContext(actor!, requested, { candidates: "always" });
  const { scope, months } = context;
  const permissions = await getReviewActionPermissions(actor);

  let rows: ReviewListRowDto[] = [];
  let headsTruncated = false;
  let headsRead = 0;
  if (months.resolved) {
    const scan = await scanHeads(scope, { periodKey: months.resolved, ceiling: HEAD_SCAN_CEILING });
    headsTruncated = scan.truncated;
    const live = await verifyLiveScope(scope, scan.heads.map((head) => head.partnerRef));
    const heads = scan.heads.filter((head) => live.has(head.partnerRef));
    headsRead = heads.length;
    const displays = await resolveDisplays(heads);
    rows = heads.map((head) => buildReviewRow(head, displays.get(head.reviewRef), live.get(head.partnerRef)?.displayName ?? null));
  }

  const candidatesInMonth = months.resolved ? context.candidates.filter((candidate) => candidate.periodKey === months.resolved).length : 0;

  return {
    ok: true,
    data: {
      month: months,
      counts: aggregateOverview(rows, candidatesInMonth),
      activity: buildRecentActivity(rows),
      permissions,
      disclosure: {
        headsRead,
        headsTruncated,
        assignmentsScanned: context.candidateScan?.scanned ?? null,
        assignmentScanTruncated: context.candidateScan?.truncated ?? false,
        scanLimit: CANDIDATE_SCAN_CEILING,
      },
    },
  };
}
