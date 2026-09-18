// Step 12B: getAnalyticsOverview - the one composition function behind
// the real Analytics Overview page. Reuses ONLY the already-scoped,
// already-authorized listAnalyticsSourceRecords (explorer-service.ts) and
// the pure read-models.ts aggregators - NEVER the global, admin-only
// rebuildAnalyticsReadModels/getGlobalAnalyticsReadModelSnapshot (see
// read-models.ts's own header comment: that snapshot is explicitly
// unscoped and must never back an ordinary actor-scoped read). A
// deliberately bounded, honest fetch (10 pages x 100 records per record
// kind, 1000 max) - never a true fetch-all; if the real dataset exceeds
// that bound, `coverageNote` says so rather than silently presenting a
// possibly-incomplete total as comprehensive.
import { absoluteTime } from "@/features/administration/format";
import { platformLabel } from "@/features/content/format";
import { formatCompact, initialsOf } from "@/features/shared/types";
import type { KpiDatum, ModuleOverview, OverviewPanelData } from "@/features/shared/types";
import { getPartnerDocsByRefs } from "@/server/partners/firestore";
import type { ActorContext } from "@/server/authz/types";

import { requireAnalyticsExploreAccess, requireAnalyticsManageAccess, requireImportsModuleAccess } from "./analytics-gate";
import { listAnalyticsSourceRecords } from "./explorer-service";
import { listAnalyticsImportBatches } from "./import-history-service";
import {
  buildAvailableDonutSegments,
  buildIngestionExceptionCategories,
  buildPlatformMetricTrend,
  computeCampaignLinkageBadge,
  computeFreshnessBadge,
  computeStaleBatchCount,
  formatPublishedContentHint,
  platformAbbreviation,
  sumMetricAcrossPlatforms,
  type IngestionExceptionCategory,
} from "./overview-metrics";
import { aggregateFreshnessByPlatform, aggregateIngestionExceptionCounts, aggregatePlatformTotals, aggregateSourceRecordCountsByPlatform, rankPartnersByMetric } from "./read-models";
import { analyticsUnauthorizedResult, type AnalyticsChannelSourceRecordDoc, type AnalyticsContentSourceRecordDoc, type AnalyticsImportBatchDoc, type AnalyticsServiceResult } from "./types";

const BOUNDED_PAGE_SIZE = 100; // explorer-service.ts's own listInputSchema caps `limit` at 100 - never exceed it.
const MAX_PAGES = 10; // 1000 records max per record kind - a deliberate, honest bound, never a true fetch-all.

async function fetchBoundedContentRecords(actor: ActorContext): Promise<{ records: AnalyticsContentSourceRecordDoc[]; truncated: boolean }> {
  const records: AnalyticsContentSourceRecordDoc[] = [];
  let cursor: Record<string, unknown> | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await listAnalyticsSourceRecords(actor, { recordKind: "content", limit: BOUNDED_PAGE_SIZE, cursor });
    if (!result.ok || result.data.recordKind !== "content") break;
    records.push(...result.data.records);
    if (!result.data.nextCursor) {
      cursor = undefined;
      break;
    }
    cursor = result.data.nextCursor as Record<string, unknown>;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { records, truncated };
}

async function fetchBoundedChannelRecords(actor: ActorContext): Promise<{ records: AnalyticsChannelSourceRecordDoc[]; truncated: boolean }> {
  const records: AnalyticsChannelSourceRecordDoc[] = [];
  let cursor: Record<string, unknown> | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await listAnalyticsSourceRecords(actor, { recordKind: "channel", limit: BOUNDED_PAGE_SIZE, cursor });
    if (!result.ok || result.data.recordKind !== "channel") break;
    records.push(...result.data.records);
    if (!result.data.nextCursor) {
      cursor = undefined;
      break;
    }
    cursor = result.data.nextCursor as Record<string, unknown>;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { records, truncated };
}

export type AnalyticsOverviewResult = {
  overview: ModuleOverview;
  canSeeImportCta: boolean;
  coverageNote: string | null;
  // The "Ingestion Exceptions" panel's real deep-link targets, keyed by
  // its own row title - src/ui/Overview.tsx's shared AttentionRows
  // component renders plain non-navigable buttons (no href/onClick in
  // its prop shape), so the page renders this ONE panel's body itself
  // (reusing the same "ov-attention"/"ov-attention-row" CSS classes, as
  // real `<Link>`s) rather than the shared OverviewPanels dispatcher -
  // see analytics/page.tsx's own comment. Never modifies src/ui/Overview.tsx.
  ingestionExceptionLinks: Record<string, string>;
};

export async function getAnalyticsOverview(actor: ActorContext | null): Promise<AnalyticsServiceResult<AnalyticsOverviewResult>> {
  const gate = await requireAnalyticsExploreAccess(actor);
  if (!gate.ok) return analyticsUnauthorizedResult(gate.reason);

  const [{ records: contentRecords, truncated: contentTruncated }, { records: channelRecords, truncated: channelTruncated }, batchesResult, importsGate, manageGate] = await Promise.all([
    fetchBoundedContentRecords(actor!),
    fetchBoundedChannelRecords(actor!),
    listAnalyticsImportBatches(actor, { limit: 50 }),
    requireImportsModuleAccess(actor),
    requireAnalyticsManageAccess(actor),
  ]);

  const batches: AnalyticsImportBatchDoc[] = batchesResult.ok ? batchesResult.data.batches : [];

  const platformTotals = aggregatePlatformTotals(contentRecords);
  const contentCountsByPlatform = aggregateSourceRecordCountsByPlatform(contentRecords);
  const contentExceptions = aggregateIngestionExceptionCounts(contentRecords);
  const channelExceptions = aggregateIngestionExceptionCounts(channelRecords);
  const freshnessByPlatform = aggregateFreshnessByPlatform(contentRecords);
  const staleBatchCount = computeStaleBatchCount(batches);

  // ---- KPIs (frozen 5-slot order) ----------------------------------------

  const kpiReach: KpiDatum = { icon: "chart", label: "Instagram reach", value: "Unavailable", hint: "Not in verified metric registry" };

  const youtubeViews = platformTotals.youtube?.views ?? null;
  const kpiViews: KpiDatum =
    youtubeViews === null
      ? { icon: "chart", label: "YouTube views", value: "Unavailable", hint: "No source-reported views yet" }
      : { icon: "chart", label: "YouTube views", value: formatCompact(youtubeViews), hint: "source-reported" };

  const publishedTotal = Object.values(contentCountsByPlatform).reduce((acc, n) => acc + n, 0);
  const kpiPublished: KpiDatum = { icon: "file", label: "Published content", value: formatCompact(publishedTotal), hint: formatPublishedContentHint(contentCountsByPlatform) };

  // "Engagement" - Section correction: sourced ONLY from the source-
  // reported `engagement` field on each record, never derived from
  // likes+comments, never including Shares (still outside the verified
  // registry - see metric-registry.ts's UNSUPPORTED_METRIC_IDS).
  const engagementAgg = sumMetricAcrossPlatforms(platformTotals, "engagement");
  const kpiEngagement: KpiDatum =
    engagementAgg.sum === null
      ? { icon: "flag", label: "Engagement", value: "Unavailable", hint: "No source-reported Engagement yet" }
      : {
          icon: "flag",
          label: "Engagement",
          value: formatCompact(engagementAgg.sum),
          hint: engagementAgg.missingPlatforms.length > 0 ? `source-reported · ${engagementAgg.coveredPlatforms.map(platformAbbreviation).join(", ")} only` : "source-reported",
        };

  const exceptionsTotal = contentExceptions.unmatched + contentExceptions.ambiguous + channelExceptions.unmatched + channelExceptions.ambiguous;
  const kpiExceptions: KpiDatum = { icon: "alert", label: "Ingestion exceptions", value: String(exceptionsTotal), hint: exceptionsTotal > 0 ? "needs review" : "none pending" };

  // ---- Top panels ---------------------------------------------------------

  const youtubeTrend = buildPlatformMetricTrend(contentRecords, "youtube", "views");
  const trendSeries = youtubeTrend ? [{ label: "YouTube views", color: "#8b4aff", unit: "", values: youtubeTrend.map((p) => p.value) }] : [];
  const trendsPanel: OverviewPanelData = {
    kind: "trends",
    icon: "chart",
    title: "Native Platform Trends",
    note: trendSeries.length > 0 ? "Source-reported views by reporting period" : "No platform trend available yet from source-reported data",
    foot: "Instagram reach is not in the verified metric registry and is never plotted here; source-reported metrics only.",
    span: 6,
    series: trendSeries,
  };

  const donutPublished: OverviewPanelData = {
    kind: "donut",
    icon: "file",
    title: "Published Content",
    note: `${publishedTotal} source content record${publishedTotal === 1 ? "" : "s"}`,
    foot: "Content counts are comparable across platforms - every committed source record, regardless of match state.",
    span: 3,
    total: publishedTotal,
    totalLabel: "Content",
    segments: Object.keys(contentCountsByPlatform)
      .sort()
      .map((platform) => ({ label: platformLabel(platform), value: contentCountsByPlatform[platform]! })),
  };

  const likesAgg = sumMetricAcrossPlatforms(platformTotals, "likes");
  const commentsAgg = sumMetricAcrossPlatforms(platformTotals, "comments");
  const engagementDonut = buildAvailableDonutSegments([
    { label: "Likes", sum: likesAgg.sum },
    { label: "Engagement", sum: engagementAgg.sum },
    { label: "Comments", sum: commentsAgg.sum },
  ]);
  const donutEngagement: OverviewPanelData = {
    kind: "donut",
    icon: "flag",
    title: "Engagement Actions",
    note: `${formatCompact(engagementDonut.total)} recorded actions`,
    // Shares is dropped from this panel entirely (not a verified metric -
    // never shown here, not even as an "Unavailable" row). A metric that
    // WAS considered but never once source-reported in this scope
    // (omittedLabels) is disclosed here rather than drawn as a fabricated
    // zero-length arc.
    foot:
      engagementDonut.omittedLabels.length > 0
        ? `${engagementDonut.omittedLabels.join(", ")} not yet source-reported for any record in scope - never shown as zero. Shares is not a verified metric and is never shown here.`
        : "Counts come from explicit source-reported values only. Shares is not a verified metric and is never shown here.",
    span: 3,
    total: engagementDonut.total,
    totalLabel: "Actions",
    segments: engagementDonut.total > 0 ? engagementDonut.segments : [],
  };

  // ---- Bottom panels --------------------------------------------------

  const rankings = rankPartnersByMetric(contentRecords, "likes").slice(0, 4);
  const partnerDocs = await getPartnerDocsByRefs(rankings.map((r) => r.partnerRef));
  const rankPanel: OverviewPanelData = {
    kind: "rank",
    icon: "users",
    title: "Top Partners",
    note: "Ranked by recorded likes",
    foot: "No hidden blended performance score - ranked by exactly one supported metric.",
    span: 3,
    rows: rankings.map((r) => {
      const name = partnerDocs.get(r.partnerRef)?.displayName ?? "Unknown partner";
      return { name, value: formatCompact(r.total), initials: initialsOf(name) };
    }),
  };

  const exceptionCategories: IngestionExceptionCategory[] = buildIngestionExceptionCategories({
    unmatchedContent: contentExceptions.unmatched,
    unmatchedChannel: channelExceptions.unmatched,
    ambiguousTotal: contentExceptions.ambiguous + channelExceptions.ambiguous,
    staleBatches: staleBatchCount,
  });
  const attentionPanel: OverviewPanelData = {
    kind: "attention",
    icon: "alert",
    title: "Ingestion Exceptions",
    note: exceptionCategories.length > 0 ? `${exceptionsTotal} exception${exceptionsTotal === 1 ? "" : "s"} across ${exceptionCategories.length} categor${exceptionCategories.length === 1 ? "y" : "ies"}` : "No ingestion exceptions right now",
    foot: "Unavailable values must not appear as zero.",
    span: 3,
    rows: exceptionCategories.map((c) => ({ title: c.title, detail: c.detail, count: String(c.count) })),
  };

  const matchedContentCount = contentRecords.filter((r) => r.matchState === "MATCHED").length;
  const campaignLinkageBadge = computeCampaignLinkageBadge(matchedContentCount, contentExceptions.unmatched + contentExceptions.ambiguous);
  const instaFreshness = freshnessByPlatform.instagram ?? null;
  const ytFreshness = freshnessByPlatform.youtube ?? null;
  const checksPanel: OverviewPanelData = {
    kind: "checks",
    icon: "check",
    title: "Data Freshness",
    note: "Most recent source record per platform, and batch health",
    foot: "Metrics remain traceable to their source snapshot.",
    span: 3,
    rows: [
      { label: "Instagram source", detail: instaFreshness ? absoluteTime(instaFreshness) : "No source data yet", badge: computeFreshnessBadge(instaFreshness) },
      { label: "YouTube source", detail: ytFreshness ? absoluteTime(ytFreshness) : "No source data yet", badge: computeFreshnessBadge(ytFreshness) },
      {
        label: "Campaign linkage",
        detail: campaignLinkageBadge === "Current" ? "All matched content linked" : campaignLinkageBadge === "Partial" ? "Some content still unresolved" : "No content matched yet",
        badge: campaignLinkageBadge,
      },
      { label: "Stale batches", detail: staleBatchCount > 0 ? `${staleBatchCount} batch${staleBatchCount === 1 ? "" : "es"} failed or completed with errors` : "None", badge: staleBatchCount > 0 ? "Action" : "None" },
    ],
  };

  const actionsPanel: OverviewPanelData = {
    kind: "actions",
    icon: "grid",
    title: "Quick Actions",
    note: "Continue from insight to action",
    foot: "Actions navigate directly; no records are changed by viewing them.",
    span: 3,
    rows: [
      { label: "Explore metrics", icon: "chart", href: "/analytics/explorer" },
      { label: "Import history", icon: "clock", href: "/analytics/import-history" },
      { label: "Compare partners", icon: "users", href: "/analytics/explorer?recordKind=content" },
      { label: "Open explorer", icon: "search", href: "/analytics/explorer" },
    ],
  };

  const overview: ModuleOverview = {
    eyebrow: "MEASURE & REVIEW",
    title: "Analytics",
    description: "Read native platform metrics with visible source quality.",
    summary: "Platform performance intelligence",
    kpis: [kpiReach, kpiViews, kpiPublished, kpiEngagement, kpiExceptions],
    topPanels: [trendsPanel, donutPublished, donutEngagement],
    bottomPanels: [rankPanel, attentionPanel, checksPanel, actionsPanel],
  };

  const coverageNote = contentTruncated || channelTruncated ? "Showing a bounded window of the most recent scoped source records - totals may not reflect the full dataset." : null;

  return {
    ok: true,
    data: {
      overview,
      canSeeImportCta: importsGate.ok && manageGate.ok,
      coverageNote,
      ingestionExceptionLinks: Object.fromEntries(exceptionCategories.map((c) => [c.title, c.href])),
    },
  };
}
