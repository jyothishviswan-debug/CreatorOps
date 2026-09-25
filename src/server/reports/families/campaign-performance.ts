import type { ActorContext } from "@/server/authz/types";
import { getPlatformAnalyticsView } from "@/server/analytics/platform-view-service";
import { PLATFORM_VIEW_IDS, type PlatformViewId } from "@/server/analytics/platform-view-metrics";
import { getCampaign } from "@/server/campaigns/campaign-service";

import { buildReportResult } from "../result-builder";
import { mapSourceError } from "../source-errors";
import type { AppliedReportFilters, ReportResult, ReportRow, ReportsServiceResult } from "../types";

// Section 12: Campaign Performance - verified (matchState === MATCHED) Analytics evidence only,
// strictly per-platform. Iterates PLATFORM_VIEW_IDS (currently exactly two: instagram, youtube) -
// small and bounded, never a browser-driven "give me every platform" fan-out. Metrics/rows are NEVER
// combined across platforms (section 6/14).
export async function runCampaignPerformanceReport(actor: ActorContext, appliedFilters: AppliedReportFilters): Promise<ReportsServiceResult<ReportResult>> {
  const generatedAt = new Date().toISOString();
  const platformFilter = appliedFilters.platform as PlatformViewId | undefined;
  const campaignRefFilter = appliedFilters.campaignRef;
  const platforms = platformFilter && (PLATFORM_VIEW_IDS as readonly string[]).includes(platformFilter) ? [platformFilter] : [...PLATFORM_VIEW_IDS];

  // Step 19C fix: a campaignRef filter must actually scope to THAT Campaign, not merely to "any row
  // with some resolved Campaign label" - the latter silently included a different Campaign's matched
  // content whenever more than one Campaign had matched evidence (a genuine cross-layer defect only
  // visible once real Analytics + Campaign fixture data existed together). Resolves the requested
  // Campaign's own name (same "getCampaign then compare the resolved label" idiom already used by
  // families/campaign-event-performance.ts and families/campaign-delivery.ts) and compares against it
  // - Analytics' own platform view carries no raw Campaign ref on a content row, only a resolved label
  // (see platform-view-dto.ts), so display-name matching is the most precise comparison available.
  let campaignName: string | null = null;
  if (campaignRefFilter) {
    const campaign = await getCampaign(actor, campaignRefFilter);
    if (!campaign.ok) return mapSourceError(campaign);
    campaignName = campaign.data.name;
  }

  const byPlatform: Record<string, { matchedContentCount: number; views: number | null; engagement: number | null }> = {};
  const rows: ReportRow[] = [];
  let latestSourceAt: string | null = null;
  let totalScanned = 0;
  let truncated = false;

  for (const platform of platforms) {
    const view = await getPlatformAnalyticsView(actor, platform);
    if (!view.ok) return mapSourceError(view);
    if (view.data.coverage.contentTruncated) truncated = true;

    let matched = view.data.publishedContent.rows.filter((row) => row.matchState === "MATCHED");
    if (campaignName) matched = matched.filter((row) => row.campaignLabel === campaignName);
    else if (campaignRefFilter) matched = matched.filter((row) => row.campaignLabel !== null);
    totalScanned += view.data.publishedContent.rows.length;

    const viewsSum = matched.reduce<number | null>((acc, row) => (row.views === null ? acc : (acc ?? 0) + row.views), null);
    const engagementSum = matched.reduce<number | null>((acc, row) => (row.engagement === null ? acc : (acc ?? 0) + row.engagement), null);
    byPlatform[platform] = { matchedContentCount: matched.length, views: viewsSum, engagement: engagementSum };

    for (const row of matched) {
      rows.push({ platform, campaignLabel: row.campaignLabel, partnerLabel: row.partnerLabel, publishedAt: row.publishedAt, views: row.views, engagement: row.engagement, likes: row.likes, comments: row.comments });
      if (row.publishedAt && (latestSourceAt === null || row.publishedAt > latestSourceAt)) latestSourceAt = row.publishedAt;
    }
  }

  const metrics: Record<string, number | string | null> = {};
  for (const platform of platforms) {
    metrics[`matchedContentCount_${platform}`] = byPlatform[platform]!.matchedContentCount;
    metrics[`views_${platform}`] = byPlatform[platform]!.views;
    metrics[`engagement_${platform}`] = byPlatform[platform]!.engagement;
  }

  return {
    ok: true,
    data: buildReportResult({
      reportId: "campaign_performance",
      generatedAt,
      // Evidence cutoff is the latest matched source record's own publishedAt - distinct from
      // generatedAt, which only says when CreatorOps ran the report (section 5).
      evidenceCutoff: latestSourceAt ?? generatedAt,
      appliedFilters,
      scopeSummary: {
        basis: "actor-scope (getPlatformAnalyticsView)",
        note: campaignName ? `Filtered to Campaign "${campaignName}".` : campaignRefFilter ? "Filtered to rows carrying a resolved Campaign label - an unresolved/out-of-scope Campaign label is excluded, never guessed." : "Every actor-scoped, MATCHED-evidence content row across the requested platform(s).",
      },
      metrics,
      rows,
      sections: { byPlatform },
      extraLimitations: campaignName ? ["Analytics rows are matched to this Campaign by its resolved display-name label (Analytics carries no stored Campaign ref on a content record) - a different Campaign that happens to share the exact same name cannot be distinguished."] : [],
      truncated,
      rowCount: rows.length,
      provenance: platforms.map((platform) => ({ sourceModule: "analytics", sourceFunction: "getPlatformAnalyticsView", recordCount: byPlatform[platform]!.matchedContentCount, scanned: totalScanned })),
    }),
  };
}
