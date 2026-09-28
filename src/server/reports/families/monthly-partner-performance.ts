import { getPlatformAnalyticsView } from "@/server/analytics/platform-view-service";
import { PLATFORM_VIEW_IDS, type PlatformViewId } from "@/server/analytics/platform-view-metrics";
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

      // partnerAnalyticsHref (a real, already-computed same-origin link to this Partner's own Analytics
      // drill-down page - see platform-view-dto.ts) is included here so the rendered PDF table can show
      // a genuine clickable link column, same discipline as every other real hyperlink in this report
      // (never a fabricated "Open Post" URL this product has no data for).
      const analyticsLink = accounts.find((a) => a.partnerAnalyticsHref !== null)?.partnerAnalyticsHref ?? matchedContent.find((c) => c.partnerAnalyticsHref !== null)?.partnerAnalyticsHref ?? null;

      rows.push({
        partnerRef: partner.partnerRef,
        partnerDisplayName: partner.displayName,
        platform,
        periodKey: periodKeyFilter ?? reviewFlags?.periodKey ?? null,
        accountCount: accounts.length,
        staleAccountCount: staleAccounts.length,
        publishedContentCount: matchedContent.length,
        views: viewsSum,
        engagement: engagementSum,
        hasFinalizedReview: reviewFlags !== null,
        hasComplianceEvidence: reviewFlags?.hasCompliance ?? null,
        hasPerformanceEvidence: reviewFlags?.hasPerformance ?? null,
        partnerAnalytics: analyticsLink,
      });
    }

    platformCoverageCount[platform] = platformAccountCoverage;
    publishedContentCount[platform] = platformPublishedContentCount;
    staleAccountCountByPlatform[platform] = platformStaleAccountCount;
  }

  // 5. Top Content - ONLY when a single Partner is selected (a bounded, single-partner Content query);
  // omitted for a multi-partner run to avoid an unbounded per-partner Content fan-out.
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

  const metrics: Record<string, number | string | null> = {
    partnerCount: partners.length,
    finalizedReviewCount: partners.filter((p) => finalizedHeadByPartner.has(p.partnerRef)).length,
    withComplianceEvidenceCount,
    withPerformanceEvidenceCount,
  };
  for (const platform of PLATFORM_VIEW_IDS) {
    metrics[`accountCoverageCount_${platform}`] = platformCoverageCount[platform] ?? 0;
    metrics[`publishedContentCount_${platform}`] = publishedContentCount[platform] ?? 0;
    metrics[`staleAccountCount_${platform}`] = staleAccountCountByPlatform[platform] ?? 0;
  }

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
      sections: { production, compliance, performance, topContent, dataQualityWarnings },
      extraLimitations: [
        "No blended score is computed anywhere in this report - Production, Compliance, Performance and per-platform Analytics metrics are reported as fully separate fields, never combined into one Partner performance number.",
        "Top Content is only computed when a single Partner is selected via the partnerRef filter (a bounded, single-partner Content query) - omitted for a multi-partner run to avoid an unbounded per-partner Content fan-out.",
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
