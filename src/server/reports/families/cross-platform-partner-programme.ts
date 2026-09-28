import { getPlatformAnalyticsView } from "@/server/analytics/platform-view-service";
import { PLATFORM_VIEW_IDS } from "@/server/analytics/platform-view-metrics";
import type { ActorContext } from "@/server/authz/types";
import { getPartner, listPartners } from "@/server/partners/partner-service";

import { buildReportResult } from "../result-builder";
import { mapSourceError } from "../source-errors";
import type { AppliedReportFilters, ReportResult, ReportRow, ReportsServiceResult } from "../types";

// Step 19A.1: Cross-Platform Partner / Programme - one row per Partner with EVERY platform metric kept
// side by side as its own separate field (followers_instagram vs followers_youtube, etc) - never
// summed or blended across platforms (no "Instagram reach + YouTube views", no synthetic cross-platform
// score). The ONE deliberate exception is publishedContentTotalAcrossPlatforms: a raw count safe to sum
// because each Content item is published on exactly one platform (no double-counting) and both
// platforms report the same unit - its definition is spelled out in the metric/limitations below.
const PARTNER_PAGE_SIZE = 25;
const STALE_AFTER_DAYS = 60; // Same Reports-owned staleness convention as channel_growth_freshness.ts.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isStaleSnapshot(snapshotAt: string, asOf: string): boolean {
  const ageMs = new Date(asOf).getTime() - new Date(snapshotAt).getTime();
  return Number.isFinite(ageMs) && ageMs > STALE_AFTER_DAYS * MS_PER_DAY;
}

export async function runCrossPlatformPartnerProgrammeReport(actor: ActorContext, appliedFilters: AppliedReportFilters): Promise<ReportsServiceResult<ReportResult>> {
  const generatedAt = new Date().toISOString();
  const partnerRefFilter = appliedFilters.partnerRef;

  let partners: { partnerRef: string; displayName: string }[];
  let partnersTruncated = false;
  if (partnerRefFilter) {
    const partner = await getPartner(actor, partnerRefFilter);
    if (!partner.ok) return mapSourceError(partner);
    partners = [{ partnerRef: partner.data.partnerRef, displayName: partner.data.displayName }];
  } else {
    const list = await listPartners(actor, { limit: PARTNER_PAGE_SIZE });
    if (!list.ok) return mapSourceError(list);
    partners = list.data.partners.map((p) => ({ partnerRef: p.partnerRef, displayName: p.displayName }));
    partnersTruncated = list.data.nextCursor !== null;
  }

  const perPartner = new Map<string, ReportRow>();
  for (const partner of partners) perPartner.set(partner.partnerRef, { partnerRef: partner.partnerRef, partnerDisplayName: partner.displayName });

  let analyticsTruncated = false;
  let latestSourceAt: string | null = null;
  const platformTotals: Record<string, { publishedContentCount: number; views: number | null; engagement: number | null; followersKnownCount: number }> = {};

  for (const platform of PLATFORM_VIEW_IDS) {
    const view = await getPlatformAnalyticsView(actor, platform);
    if (!view.ok) return mapSourceError(view);
    if (view.data.coverage.contentTruncated || view.data.coverage.channelTruncated) analyticsTruncated = true;

    let platformPublished = 0;
    let platformViews: number | null = null;
    let platformEngagement: number | null = null;
    let followersKnown = 0;

    for (const partner of partners) {
      const accounts = view.data.partnerAccounts.rows.filter((row) => row.partnerLabel === partner.displayName);
      const matched = view.data.publishedContent.rows.filter((row) => row.matchState === "MATCHED" && row.partnerLabel === partner.displayName);

      const followers = accounts.find((a) => a.profileFollowers !== null)?.profileFollowers ?? null;
      const viewsSum = matched.reduce<number | null>((acc, r) => (r.views === null ? acc : (acc ?? 0) + r.views), null);
      const engagementSum = matched.reduce<number | null>((acc, r) => (r.engagement === null ? acc : (acc ?? 0) + r.engagement), null);
      const staleCount = accounts.filter((a) => isStaleSnapshot(a.snapshotAt, generatedAt)).length;

      // A real, already-computed same-origin Partner Analytics drill-down link (see platform-view-dto.ts)
      // - never a fabricated post URL this product has no data for.
      const analyticsLink = accounts.find((a) => a.partnerAnalyticsHref !== null)?.partnerAnalyticsHref ?? matched.find((r) => r.partnerAnalyticsHref !== null)?.partnerAnalyticsHref ?? null;

      const entry = perPartner.get(partner.partnerRef)!;
      entry[`followers_${platform}`] = followers;
      entry[`publishedContentCount_${platform}`] = matched.length;
      entry[`views_${platform}`] = viewsSum;
      entry[`engagement_${platform}`] = engagementSum;
      entry[`staleAccountCount_${platform}`] = staleCount;
      entry[`partnerAnalytics_${platform}`] = analyticsLink;

      platformPublished += matched.length;
      if (viewsSum !== null) platformViews = (platformViews ?? 0) + viewsSum;
      if (engagementSum !== null) platformEngagement = (platformEngagement ?? 0) + engagementSum;
      if (followers !== null) followersKnown += 1;

      for (const a of accounts) if (a.snapshotAt > (latestSourceAt ?? "")) latestSourceAt = a.snapshotAt;
      for (const r of matched) if (r.publishedAt && (latestSourceAt === null || r.publishedAt > latestSourceAt)) latestSourceAt = r.publishedAt;
    }

    platformTotals[platform] = { publishedContentCount: platformPublished, views: platformViews, engagement: platformEngagement, followersKnownCount: followersKnown };
  }

  const rows: ReportRow[] = [...perPartner.values()].map((entry) => {
    const publishedTotal = PLATFORM_VIEW_IDS.reduce<number>((sum, platform) => sum + (Number(entry[`publishedContentCount_${platform}`]) || 0), 0);
    return { ...entry, publishedContentTotalAcrossPlatforms: publishedTotal };
  });

  const metrics: Record<string, number | string | null> = { partnerCount: partners.length };
  for (const platform of PLATFORM_VIEW_IDS) {
    metrics[`publishedContentCount_${platform}`] = platformTotals[platform]!.publishedContentCount;
    metrics[`views_${platform}`] = platformTotals[platform]!.views;
    metrics[`engagement_${platform}`] = platformTotals[platform]!.engagement;
    metrics[`followersKnownCount_${platform}`] = platformTotals[platform]!.followersKnownCount;
  }
  metrics.publishedContentTotalAcrossPlatforms = PLATFORM_VIEW_IDS.reduce((sum, platform) => sum + platformTotals[platform]!.publishedContentCount, 0);

  const truncated = partnersTruncated || analyticsTruncated;

  return {
    ok: true,
    data: buildReportResult({
      reportId: "cross_platform_partner_programme",
      generatedAt,
      evidenceCutoff: latestSourceAt ?? generatedAt,
      appliedFilters,
      scopeSummary: {
        basis: "actor-scope (listPartners/getPartner + getPlatformAnalyticsView)",
        note: partnerRefFilter ? "Scoped to the requested Partner." : `Every actor-scoped Partner in the bounded page (up to ${PARTNER_PAGE_SIZE}), with each tracked platform's own metrics kept side by side.`,
      },
      metrics,
      rows,
      sections: { byPartner: rows },
      extraLimitations: [
        "Followers, Views and Engagement are always kept as fully separate per-platform figures (e.g. followers_instagram vs followers_youtube) - never summed or blended across platforms, and no synthetic cross-platform score is ever computed.",
        "The ONE exception is publishedContentTotalAcrossPlatforms: a raw count of matched Content items published on Instagram plus YouTube for a Partner. This is safe to sum because each Content item is published on exactly one platform (no double-counting) and both platforms report the same unit (a count of items) - it is never applied to followers, views or engagement, which have no such guarantee (e.g. the same person can follow a Partner on both platforms, so summing followers would double-count audience; views/engagement are platform-native interaction counts with no shared meaning across platforms).",
        partnersTruncated ? `More Partners exist than the bounded page of ${PARTNER_PAGE_SIZE} returned - some Partners are not represented in this run.` : "",
      ].filter((s) => s.length > 0),
      truncated,
      rowCount: rows.length,
      provenance: [
        { sourceModule: "partners", sourceFunction: partnerRefFilter ? "getPartner" : "listPartners", recordCount: partners.length },
        ...PLATFORM_VIEW_IDS.map((platform) => ({ sourceModule: "analytics", sourceFunction: "getPlatformAnalyticsView", recordCount: platformTotals[platform]!.publishedContentCount })),
      ],
    }),
  };
}
