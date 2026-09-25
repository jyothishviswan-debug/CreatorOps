import { getPlatformAnalyticsView } from "@/server/analytics/platform-view-service";
import { PLATFORM_VIEW_IDS, type PlatformViewId } from "@/server/analytics/platform-view-metrics";
import { listAssignments } from "@/server/assignments/assignment-service";
import type { ActorContext } from "@/server/authz/types";
import { getCampaign } from "@/server/campaigns/campaign-service";
import { listContent } from "@/server/content/content-service";

import { buildReportResult } from "../result-builder";
import { mapSourceError } from "../source-errors";
import type { AppliedReportFilters, ReportResult, ReportRow, ReportsServiceResult } from "../types";

// Step 19A.1: Campaign / Event Performance - there is no separate Event entity anywhere in this
// product (confirmed by a repo-wide search); per this family's own spec, "Event" is treated as
// Campaign, never invented as a new entity. Combines Campaign Delivery's own Assignment+Content
// fulfillment/publication composition with Campaign Performance's own per-platform (never combined)
// Analytics composition, plus a bounded "trajectory" (ordered matched-content data points) and
// single-explicit-metric-at-a-time contributor leaderboards (never a blended contributor score).
const ASSIGNMENT_PAGE_SIZE = 100;
const CONTENT_PAGE_SIZE = 100;
const CONTRIBUTOR_CAP = 5;

export async function runCampaignEventPerformanceReport(actor: ActorContext, appliedFilters: AppliedReportFilters): Promise<ReportsServiceResult<ReportResult>> {
  const generatedAt = new Date().toISOString();
  const campaignRef = appliedFilters.campaignRef;
  const platformFilter = appliedFilters.platform as PlatformViewId | undefined;
  const platforms = platformFilter && (PLATFORM_VIEW_IDS as readonly string[]).includes(platformFilter) ? [platformFilter] : [...PLATFORM_VIEW_IDS];

  let campaignName: string | null = null;
  if (campaignRef) {
    const campaign = await getCampaign(actor, campaignRef);
    if (!campaign.ok) return mapSourceError(campaign);
    campaignName = campaign.data.name;
  }

  const [assignmentsResult, contentResult] = await Promise.all([
    listAssignments(actor, { limit: ASSIGNMENT_PAGE_SIZE, campaignRef }),
    listContent(actor, { limit: CONTENT_PAGE_SIZE, campaignRef }),
  ]);
  if (!assignmentsResult.ok) return mapSourceError(assignmentsResult);
  if (!contentResult.ok) return mapSourceError(contentResult);

  const assignments = assignmentsResult.data.assignments;
  const content = contentResult.data.content;
  const now = generatedAt;

  const completedAssignmentCount = assignments.filter((a) => a.status === "COMPLETED").length;
  const overdueAssignmentCount = assignments.filter((a) => a.brief.dueAt !== null && a.brief.dueAt < now && a.status !== "COMPLETED" && a.status !== "CANCELLED").length;
  const contentApprovedCount = content.filter((c) => c.status === "APPROVED").length;
  const contentUnderReviewCount = content.filter((c) => c.status === "UNDER_REVIEW" || c.status === "REVISION_REQUESTED").length;

  const assignedPartners: ReportRow[] = [...new Map(assignments.map((a) => [a.partnerRef, { partnerRef: a.partnerRef, partnerDisplayName: a.partnerDisplayName }])).values()];

  const assignmentRows: ReportRow[] = assignments.map((a) => ({
    assignmentRef: a.assignmentRef,
    partnerRef: a.partnerRef,
    partnerDisplayName: a.partnerDisplayName,
    status: a.status,
    dueAt: a.brief.dueAt,
    overdue: a.brief.dueAt !== null && a.brief.dueAt < now && a.status !== "COMPLETED" && a.status !== "CANCELLED",
  }));
  const contentRows: ReportRow[] = content.map((c) => ({ contentRef: c.contentRef, partnerRef: c.partnerRef, partnerDisplayName: c.partnerDisplayName, status: c.status, dueAt: c.dueAt, approvedAt: c.approvedAt }));

  const byPlatform: Record<string, { matchedContentCount: number; views: number | null; engagement: number | null }> = {};
  const trajectoryByPlatform: Record<string, ReportRow[]> = {};
  const contributorsByViews: Record<string, ReportRow[]> = {};
  const contributorsByEngagement: Record<string, ReportRow[]> = {};
  let analyticsTruncated = false;
  let latestSourceAt: string | null = null;
  let totalScanned = 0;

  for (const platform of platforms) {
    const view = await getPlatformAnalyticsView(actor, platform);
    if (!view.ok) return mapSourceError(view);
    if (view.data.coverage.contentTruncated) analyticsTruncated = true;
    totalScanned += view.data.publishedContent.rows.length;

    let matched = view.data.publishedContent.rows.filter((row) => row.matchState === "MATCHED");
    if (campaignName) matched = matched.filter((row) => row.campaignLabel === campaignName);
    else if (campaignRef) matched = matched.filter((row) => row.campaignLabel !== null);

    const viewsSum = matched.reduce<number | null>((acc, row) => (row.views === null ? acc : (acc ?? 0) + row.views), null);
    const engagementSum = matched.reduce<number | null>((acc, row) => (row.engagement === null ? acc : (acc ?? 0) + row.engagement), null);
    byPlatform[platform] = { matchedContentCount: matched.length, views: viewsSum, engagement: engagementSum };

    const ordered = [...matched].sort((a, b) => ((a.publishedAt ?? "") < (b.publishedAt ?? "") ? -1 : 1));
    trajectoryByPlatform[platform] = ordered.map((row) => ({ publishedAt: row.publishedAt, partnerLabel: row.partnerLabel, views: row.views, engagement: row.engagement }));

    const viewsByPartner = new Map<string, number>();
    const engagementByPartner = new Map<string, number>();
    for (const row of matched) {
      if (row.publishedAt && (latestSourceAt === null || row.publishedAt > latestSourceAt)) latestSourceAt = row.publishedAt;
      if (!row.partnerLabel) continue;
      if (row.views !== null) viewsByPartner.set(row.partnerLabel, (viewsByPartner.get(row.partnerLabel) ?? 0) + row.views);
      if (row.engagement !== null) engagementByPartner.set(row.partnerLabel, (engagementByPartner.get(row.partnerLabel) ?? 0) + row.engagement);
    }
    contributorsByViews[platform] = [...viewsByPartner.entries()].sort((a, b) => b[1] - a[1]).slice(0, CONTRIBUTOR_CAP).map(([partnerLabel, views]) => ({ partnerLabel, views }));
    contributorsByEngagement[platform] = [...engagementByPartner.entries()].sort((a, b) => b[1] - a[1]).slice(0, CONTRIBUTOR_CAP).map(([partnerLabel, engagement]) => ({ partnerLabel, engagement }));
  }

  const metrics: Record<string, number | string | null> = {
    assignmentCount: assignments.length,
    completedAssignmentCount,
    overdueAssignmentCount,
    contentApprovedCount,
    contentUnderReviewCount,
  };
  for (const platform of platforms) {
    metrics[`matchedContentCount_${platform}`] = byPlatform[platform]!.matchedContentCount;
    metrics[`views_${platform}`] = byPlatform[platform]!.views;
    metrics[`engagement_${platform}`] = byPlatform[platform]!.engagement;
  }

  const rows: ReportRow[] = [...assignmentRows, ...contentRows];
  const truncated = assignmentsResult.data.nextCursor !== null || contentResult.data.nextCursor !== null || analyticsTruncated;

  return {
    ok: true,
    data: buildReportResult({
      reportId: "campaign_event_performance",
      generatedAt,
      // Assignment/Content evidence is always current-as-of-generatedAt (a live canonical read); the
      // combined result's own evidenceCutoff follows the Analytics-sourced figure (same convention as
      // campaign_performance.ts) since that is the genuinely older of the two inputs.
      evidenceCutoff: latestSourceAt ?? generatedAt,
      appliedFilters,
      scopeSummary: {
        basis: "actor-scope (listAssignments/listContent/getPlatformAnalyticsView)",
        note: campaignName
          ? `Scoped to Campaign "${campaignName}" (there is no separate Event entity in this product - "Event" is treated as Campaign, per this report's own definition).`
          : "Scoped to every Campaign the actor's own grants permit.",
      },
      metrics,
      rows,
      sections: { assignedPartners, assignments: assignmentRows, content: contentRows, contentByPlatform: byPlatform, trajectoryByPlatform, contributorsByViews, contributorsByEngagement },
      extraLimitations: [
        campaignName
          ? "Analytics rows are matched to this Campaign by its resolved display-name label (Analytics carries no stored Campaign ref on a content record) - a different Campaign that happens to share the exact same name cannot be distinguished."
          : "No campaignRef filter was applied - Analytics rows are included only when they already carry ANY resolved Campaign label, never a guess at which Campaign.",
        "Trajectory is the ordered set of individual matched-content data points within each platform's own bounded most-recent-content window (see truncation) - not a calendar-period aggregate trend.",
        "Contributors are ranked by exactly ONE explicit metric at a time (Views, separately Engagement) per platform - never a blended contributor score, and never combined across platforms.",
      ],
      truncated,
      rowCount: rows.length,
      provenance: [
        { sourceModule: "assignments", sourceFunction: "listAssignments", recordCount: assignments.length },
        { sourceModule: "content", sourceFunction: "listContent", recordCount: content.length },
        ...platforms.map((platform) => ({ sourceModule: "analytics", sourceFunction: "getPlatformAnalyticsView", recordCount: byPlatform[platform]!.matchedContentCount, scanned: totalScanned })),
      ],
    }),
  };
}
