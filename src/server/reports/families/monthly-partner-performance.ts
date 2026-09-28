import { getPlatformAnalyticsView } from "@/server/analytics/platform-view-service";
import { PLATFORM_VIEW_IDS, PUBLISHED_CONTENT_ROW_LIMIT, type PlatformViewId } from "@/server/analytics/platform-view-metrics";
import type { ActorContext } from "@/server/authz/types";
import { listContent } from "@/server/content/content-service";
import { getPartnerReview } from "@/server/partner-reviews/partner-review-service";
import { listPartnerReviewHeads } from "@/server/partner-reviews/partner-review-list-service";
import { getPartner, listPartners } from "@/server/partners/partner-service";

import { buildReportResult } from "../result-builder";
import { mapSourceError } from "../source-errors";
import type { AppliedReportFilters, ReportResult, ReportRow, ReportsServiceResult } from "../types";

// Step 19A.1: Monthly Partner Performance - a per-Partner, per-month composition of Partner Accounts +
// Analytics (kept strictly per-platform - never blended) + finalized Partner Review evidence (kept as
// three fully separate Production/Compliance/Performance sections, exactly the partner-review-evidence
// pattern) + a small bounded Content read used ONLY to give an honest "output count" (Analytics'
// matched content already covers "published output"/"platform-specific metrics"; Content module is the
// genuinely distinct source for actual submitted/approved Content pieces). NO blended score anywhere.
const STALE_AFTER_DAYS = 60; // Same Reports-owned staleness convention as channel_growth_freshness.ts.
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PARTNER_PAGE_SIZE = 25;
const HEAD_PAGE_SIZE = 50;
const DETAIL_FETCH_CAP = 20; // Same accepted bounded-fan-out cap as partner-review-evidence.ts.
const TOP_CONTENT_CAP = 5;
// Spec section 10: the bounded multi-Partner Top Content candidates come from the SAME already-bounded
// Analytics evidence window every other part of this family already reads (view.data.publishedContent.
// rows, capped upstream at PUBLISHED_CONTENT_ROW_LIMIT per platform) - this constant is only referenced
// here to state that bound honestly in the report's own disclosed limitation text, never re-declared.
const TOP_CONTENT_EVIDENCE_WINDOW = PUBLISHED_CONTENT_ROW_LIMIT;

function isStaleSnapshot(snapshotAt: string, asOf: string): boolean {
  const ageMs = new Date(asOf).getTime() - new Date(snapshotAt).getTime();
  return Number.isFinite(ageMs) && ageMs > STALE_AFTER_DAYS * MS_PER_DAY;
}

export async function runMonthlyPartnerPerformanceReport(actor: ActorContext, appliedFilters: AppliedReportFilters): Promise<ReportsServiceResult<ReportResult>> {
  const generatedAt = new Date().toISOString();
  const partnerRefFilter = appliedFilters.partnerRef;
  const periodKeyFilter = appliedFilters.period;

  // 1. Resolve the bounded Partner set - ONE call either way, never a per-partner fan-out.
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

  // 2. Review heads - ONE bounded query across every partner in scope (never a per-partner HEAD fan-out).
  const headsResult = await listPartnerReviewHeads(actor, { limit: HEAD_PAGE_SIZE, partnerRef: partnerRefFilter, periodKey: periodKeyFilter });
  if (!headsResult.ok) return mapSourceError(headsResult);
  const finalizedHeadByPartner = new Map<string, (typeof headsResult.data.heads)[number]>();
  for (const head of headsResult.data.heads) {
    if (head.currentFinalizedVersion !== null) finalizedHeadByPartner.set(head.partnerRef, head);
  }

  // 3. Review DETAIL - bounded fan-out capped at DETAIL_FETCH_CAP (same accepted pattern as partner-review-evidence.ts).
  const detailTargets = [...finalizedHeadByPartner.values()].slice(0, DETAIL_FETCH_CAP);
  const details = await Promise.all(detailTargets.map((head) => getPartnerReview(actor, head.reviewRef, { version: head.currentFinalizedVersion! })));

  const production: ReportRow[] = [];
  const compliance: ReportRow[] = [];
  const performance: ReportRow[] = [];
  let withComplianceEvidenceCount = 0;
  let withPerformanceEvidenceCount = 0;
  let latestFinalizedAt: string | null = null;
  const reviewFlagsByPartner = new Map<string, { hasCompliance: boolean; hasPerformance: boolean; periodKey: string }>();

  for (let i = 0; i < detailTargets.length; i++) {
    const head = detailTargets[i]!;
    const detail = details[i]!;
    if (!detail.ok) continue; // a since-changed/denied individual review is skipped, not fatal to the report
    const version = detail.data.selectedVersion;
    if (!version) continue;
    if (version.finalizedAt && (latestFinalizedAt === null || version.finalizedAt > latestFinalizedAt)) latestFinalizedAt = version.finalizedAt;

    const hasCompliance = version.snapshot.compliance.assignments.length > 0;
    const hasPerformance = version.snapshot.performance.records.length > 0;
    if (hasCompliance) withComplianceEvidenceCount++;
    if (hasPerformance) withPerformanceEvidenceCount++;
    reviewFlagsByPartner.set(head.partnerRef, { hasCompliance, hasPerformance, periodKey: head.periodKey });

    production.push({ partnerRef: head.partnerRef, partnerDisplayName: head.partnerDisplayName, periodKey: head.periodKey, assignmentsIncluded: version.snapshot.production.assignments.length });
    compliance.push({ partnerRef: head.partnerRef, partnerDisplayName: head.partnerDisplayName, periodKey: head.periodKey, assignmentsIncluded: version.snapshot.compliance.assignments.length });
    performance.push({ partnerRef: head.partnerRef, partnerDisplayName: head.partnerDisplayName, periodKey: head.periodKey, recordCount: version.snapshot.performance.records.length });
  }

  // 4. Analytics - the fixed, small PLATFORM_VIEW_IDS set (two calls total), matched to Partners in
  // memory by displayName (the same idiom channel_growth_freshness.ts/campaign_performance.ts already use).
  const rows: ReportRow[] = [];
  let analyticsTruncated = false;
  let latestSourceAt: string | null = null;
  const platformCoverageCount: Record<string, number> = {};
  const publishedContentCount: Record<string, number> = {};
  const staleAccountCountByPlatform: Record<string, number> = {};
  // Reports PDF Composition & Management-Publication Polish (spec sections 9/10): per-Partner individual
  // Content view values (for the per-Partner View-Band Distribution matrix) and network-wide Top Content
  // candidates (for the bounded multi-Partner Top-N), keyed by platform. Both are built from the SAME
  // already-fetched, already-bounded `view.data.publishedContent.rows` this family already reads - no
  // new Firestore query. `ReportRow` is scalar-only, so these live on `sections` (arbitrary shape)
  // rather than on a row, exactly like `production`/`compliance`/`performance`/`topContent` below.
  const viewsByPartnerPlatform: Record<PlatformViewId, Record<string, (number | null)[]>> = { instagram: {}, youtube: {} };
  const topContentCandidatesByPlatform: Record<PlatformViewId, ReportRow[]> = { instagram: [], youtube: [] };

  for (const platform of PLATFORM_VIEW_IDS) {
    const view = await getPlatformAnalyticsView(actor, platform);
    if (!view.ok) return mapSourceError(view);
    if (view.data.coverage.contentTruncated || view.data.coverage.channelTruncated) analyticsTruncated = true;

    let platformAccountCoverage = 0;
    let platformPublishedContentCount = 0;
    let platformStaleAccountCount = 0;

    for (const partner of partners) {
      const accounts = view.data.partnerAccounts.rows.filter((row) => row.partnerLabel === partner.displayName);
      const matchedContent = view.data.publishedContent.rows.filter((row) => row.matchState === "MATCHED" && row.partnerLabel === partner.displayName);
      const staleAccounts = accounts.filter((account) => isStaleSnapshot(account.snapshotAt, generatedAt));

      if (accounts.length > 0) platformAccountCoverage += 1;
      platformPublishedContentCount += matchedContent.length;
      platformStaleAccountCount += staleAccounts.length;

      for (const account of accounts) if (account.snapshotAt > (latestSourceAt ?? "")) latestSourceAt = account.snapshotAt;
      for (const row of matchedContent) if (row.publishedAt && (latestSourceAt === null || row.publishedAt > latestSourceAt)) latestSourceAt = row.publishedAt;

      // Nothing to report for this Partner+platform - omitted entirely rather than a fabricated
      // zero-everything row (missing != zero).
      if (accounts.length === 0 && matchedContent.length === 0) continue;

      const reviewFlags = reviewFlagsByPartner.get(partner.partnerRef) ?? null;
      const viewsSum = matchedContent.reduce<number | null>((acc, r) => (r.views === null ? acc : (acc ?? 0) + r.views), null);
      const engagementSum = matchedContent.reduce<number | null>((acc, r) => (r.engagement === null ? acc : (acc ?? 0) + r.engagement), null);
      const likesSum = matchedContent.reduce<number | null>((acc, r) => (r.likes === null ? acc : (acc ?? 0) + r.likes), null);
      const commentsSum = matchedContent.reduce<number | null>((acc, r) => (r.comments === null ? acc : (acc ?? 0) + r.comments), null);
      // Followers/subscribers: ONE account's latest verified snapshot value (never summed across
      // accounts, never presented as growth - same discipline platform-view-metrics.ts's own selection
      // already enforces upstream). Omitted (null) when no account carries a reported value.
      const followersSnapshot = accounts.find((a) => a.profileFollowers !== null)?.profileFollowers ?? null;
      // Spec section 5: "Content with Metrics" is the honest subset of publishedContentCount that
      // actually carries at least one reported source metric (views/likes/comments/engagement) - never
      // conflated with the raw matched-content count, which may include items with no metric reported at
      // all (e.g. a post matched by URL before its metrics were imported).
      const contentWithMetricsCount = matchedContent.filter((c) => c.views !== null || c.likes !== null || c.comments !== null || c.engagement !== null).length;

      // partnerAnalyticsHref (a real, already-computed same-origin link to this Partner's own Analytics
      // drill-down page - see platform-view-dto.ts) backs a genuine "Open Partner" clickable link column
      // (spec section 7's paired-column convention: `openPartner` carries the human label text,
      // `openPartnerHref` carries the URL - see pdf-renderer.ts's drawTable and helpers.ts's
      // dropUninformativeColumns, which strips the *Href field from the rendered column list).
      const analyticsLink = accounts.find((a) => a.partnerAnalyticsHref !== null)?.partnerAnalyticsHref ?? matchedContent.find((c) => c.partnerAnalyticsHref !== null)?.partnerAnalyticsHref ?? null;

      rows.push({
        partnerRef: partner.partnerRef,
        partnerDisplayName: partner.displayName,
        platform,
        periodKey: periodKeyFilter ?? reviewFlags?.periodKey ?? null,
        accountCount: accounts.length,
        staleAccountCount: staleAccounts.length,
        publishedContentCount: matchedContent.length,
        contentWithMetricsCount,
        followersSnapshot,
        views: viewsSum,
        likes: likesSum,
        comments: commentsSum,
        engagement: engagementSum,
        hasFinalizedReview: reviewFlags !== null,
        hasComplianceEvidence: reviewFlags?.hasCompliance ?? null,
        hasPerformanceEvidence: reviewFlags?.hasPerformance ?? null,
        openPartner: analyticsLink ? "Open Partner" : null,
        openPartnerHref: analyticsLink,
      });

      // Spec section 9: per-Partner View-Band Distribution needs each individual Content item's own
      // views value (missing views excluded, never counted as the 0-1K band - see bands.ts's own
      // omittedNullCount handling, unchanged and reused as-is per-Partner here).
      viewsByPartnerPlatform[platform][partner.partnerRef] = matchedContent.map((c) => c.views);
    }

    // Spec section 10: bounded, report-scoped, multi-Partner Top Content candidates for this platform -
    // every MATCHED Content item already returned for a Partner actually in THIS report's scope (never
    // an unbounded per-partner fan-out: this is the SAME already-fetched, already-bounded
    // view.data.publishedContent.rows array the loop above reads from, filtered in memory).
    const inScopeDisplayNames = new Set(partners.map((p) => p.displayName));
    topContentCandidatesByPlatform[platform] = view.data.publishedContent.rows
      .filter((r) => r.matchState === "MATCHED" && r.partnerLabel !== null && inScopeDisplayNames.has(r.partnerLabel))
      .map((r) => ({
        partnerDisplayName: r.partnerLabel,
        publishedAt: r.publishedAt,
        views: r.views,
        likes: r.likes,
        comments: r.comments,
        engagement: r.engagement,
        openPost: r.postUrl ? "Open Post" : null,
        openPostHref: r.postUrl,
        openPartner: r.postUrl ? null : r.partnerAnalyticsHref ? "Open Partner" : null,
        openPartnerHref: r.postUrl ? null : r.partnerAnalyticsHref,
      }));

    platformCoverageCount[platform] = platformAccountCoverage;
    publishedContentCount[platform] = platformPublishedContentCount;
    staleAccountCountByPlatform[platform] = platformStaleAccountCount;
  }

  // 5. Top Content (legacy, single-Partner recency list - superseded on the PDF by the bounded
  // multi-Partner Top-N built from topContentCandidatesByPlatform above, spec section 10) - kept only
  // when a single Partner is selected, since it is still a genuinely distinct source (actual submitted/
  // approved Content pieces, not Analytics' matched-content rows) that the Data Quality/XLSX layer may
  // still find useful for a single-Partner run.
  let topContent: ReportRow[] = [];
  if (partnerRefFilter) {
    const contentResult = await listContent(actor, { partnerRef: partnerRefFilter, limit: TOP_CONTENT_CAP });
    if (!contentResult.ok) return mapSourceError(contentResult);
    topContent = contentResult.data.content.map((c) => ({ contentRef: c.contentRef, campaignName: c.campaignName, status: c.status, dueAt: c.dueAt, approvedAt: c.approvedAt }));
  }

  const partnersWithNoAnalyticsRow = partners.filter((p) => !rows.some((r) => r.partnerRef === p.partnerRef)).length;
  const dataQualityWarnings: string[] = [];
  if (partnersTruncated) dataQualityWarnings.push(`More Partners exist than the bounded page of ${PARTNER_PAGE_SIZE} returned - some Partners are not represented in this run.`);
  if (finalizedHeadByPartner.size > DETAIL_FETCH_CAP) dataQualityWarnings.push(`Full Review evidence is included for only the first ${DETAIL_FETCH_CAP} finalized reviews found in this run; the remainder are counted but not detailed.`);
  if (analyticsTruncated) dataQualityWarnings.push("Analytics evidence was truncated at its own bounded read window for at least one platform - some source records were not scanned.");
  if (partnersWithNoAnalyticsRow > 0) dataQualityWarnings.push(`${partnersWithNoAnalyticsRow} Partner(s) in this run have no Analytics account or matched content on either platform - shown with no Analytics row rather than a fabricated zero.`);

  // Spec section 11 (management KPI hierarchy): the headline KPI set prioritizes Partner count,
  // Account/page/channel coverage, Published Content, Views and Engagement - in that order, keyed so
  // the builder can present them as the PRIMARY KPI grid. The zero-valued-until-reviewed Review-evidence
  // counters (finalizedReviewCount/withComplianceEvidenceCount/withPerformanceEvidenceCount) are kept in
  // this SAME metrics record (nothing is deleted - XLSX/API still see every figure) but ordered last and
  // named so the builder can split them into a separate, secondary "Partner Review Evidence Coverage"
  // KPI section rather than mixing them into the primary headline grid (see builders/monthly-partner-
  // performance.ts's REVIEW_EVIDENCE_METRIC_IDS).
  const metrics: Record<string, number | string | null> = { partnerCount: partners.length };
  for (const platform of PLATFORM_VIEW_IDS) {
    const platformViewsTotal = rows.filter((r) => r.platform === platform).reduce<number | null>((acc, r) => (typeof r.views === "number" ? (acc ?? 0) + r.views : acc), null);
    const platformEngagementTotal = rows.filter((r) => r.platform === platform).reduce<number | null>((acc, r) => (typeof r.engagement === "number" ? (acc ?? 0) + r.engagement : acc), null);
    metrics[`accountCoverageCount_${platform}`] = platformCoverageCount[platform] ?? 0;
    metrics[`publishedContentCount_${platform}`] = publishedContentCount[platform] ?? 0;
    metrics[`views_${platform}`] = platformViewsTotal;
    metrics[`engagement_${platform}`] = platformEngagementTotal;
    metrics[`staleAccountCount_${platform}`] = staleAccountCountByPlatform[platform] ?? 0;
  }
  metrics.finalizedReviewCount = partners.filter((p) => finalizedHeadByPartner.has(p.partnerRef)).length;
  metrics.withComplianceEvidenceCount = withComplianceEvidenceCount;
  metrics.withPerformanceEvidenceCount = withPerformanceEvidenceCount;

  const evidenceCutoff = [latestFinalizedAt, latestSourceAt].filter((v): v is string => v !== null).sort().pop() ?? generatedAt;
  const truncated = partnersTruncated || analyticsTruncated || headsResult.data.nextCursor !== null || finalizedHeadByPartner.size > DETAIL_FETCH_CAP;

  return {
    ok: true,
    data: buildReportResult({
      reportId: "monthly_partner_performance",
      generatedAt,
      evidenceCutoff,
      appliedFilters,
      scopeSummary: {
        basis: "actor-scope (listPartners/getPartner + listPartnerReviewHeads/getPartnerReview + getPlatformAnalyticsView)",
        note: partnerRefFilter ? "Scoped to the requested Partner." : `Every actor-scoped Partner in the bounded page (up to ${PARTNER_PAGE_SIZE}), for the applied period.`,
      },
      metrics,
      rows,
      sections: {
        production,
        compliance,
        performance,
        topContent,
        dataQualityWarnings,
        viewsByPartnerPlatform,
        topContentCandidatesByPlatform,
        // Spec section 13 (Partner Account Directory / Appendix): the FULL bounded Partner roster (not
        // just the subset that happened to have at least one tracked account/content row on some
        // platform) - so the appendix can show a genuine "N/A"/"Not tracked" state for a Partner with no
        // coverage on either platform, instead of silently omitting that Partner from the directory.
        partnerRoster: partners.map((p) => ({ partnerRef: p.partnerRef, partnerDisplayName: p.displayName })),
      },
      extraLimitations: [
        "No blended score is computed anywhere in this report - Production, Compliance, Performance and per-platform Analytics metrics are reported as fully separate fields, never combined into one Partner performance number.",
        `Top Content is ranked among the ${TOP_CONTENT_EVIDENCE_WINDOW} most recently published Content items tracked per platform (the same bounded Analytics evidence window the performance tables draw from) - not an all-time top list.`,
        finalizedHeadByPartner.size > DETAIL_FETCH_CAP ? `Full Review evidence is included for only the first ${DETAIL_FETCH_CAP} finalized reviews found in this run; the remainder are not detailed.` : "",
        partnersTruncated ? `More Partners exist than the bounded page of ${PARTNER_PAGE_SIZE} returned - some Partners are not represented in this run.` : "",
      ].filter((s) => s.length > 0),
      truncated,
      rowCount: rows.length,
      provenance: [
        { sourceModule: "partners", sourceFunction: partnerRefFilter ? "getPartner" : "listPartners", recordCount: partners.length },
        { sourceModule: "partner_reviews", sourceFunction: "listPartnerReviewHeads", recordCount: headsResult.data.heads.length },
        { sourceModule: "partner_reviews", sourceFunction: "getPartnerReview", recordCount: detailTargets.length, scanned: detailTargets.length },
        ...PLATFORM_VIEW_IDS.map((platform: PlatformViewId) => ({ sourceModule: "analytics", sourceFunction: "getPlatformAnalyticsView", recordCount: rows.filter((r) => r.platform === platform).length })),
        ...(partnerRefFilter ? [{ sourceModule: "content", sourceFunction: "listContent", recordCount: topContent.length }] : []),
      ],
    }),
  };
}
