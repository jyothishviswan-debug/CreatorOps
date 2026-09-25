import { getPlatformAnalyticsView } from "@/server/analytics/platform-view-service";
import { PLATFORM_VIEW_IDS, type PlatformViewId } from "@/server/analytics/platform-view-metrics";
import type { ActorContext } from "@/server/authz/types";
import { derivePeriod, toUtcDate, type ReviewPeriod } from "@/server/partner-reviews/period";
import { getPartnerReview } from "@/server/partner-reviews/partner-review-service";
import { listPartnerReviewHeads } from "@/server/partner-reviews/partner-review-list-service";
import { getPartner } from "@/server/partners/partner-service";

import { buildReportResult } from "../result-builder";
import { mapSourceError } from "../source-errors";
import { reportsInvalidInputResult } from "../types";
import type { AppliedReportFilters, ReportResult, ReportRow, ReportsServiceResult } from "../types";

// Step 19A.1: Long-Period Partner Programme - there is no existing "multi-period aggregation window"
// concept anywhere in this codebase, so this family defines one itself, honestly and boundedly: the
// caller supplies a small, EXPLICIT, bounded set of period keys (never an open-ended date range) via
// the "periods" filter (a comma-separated YYYY-MM list, capped at MAX_PERIODS) - never an unbounded
// scan of "every period there ever was". Evidence for each requested period is composed by calling the
// existing per-period-capable source functions (Partner Review's own periodKey filter; Analytics' own
// per-record timestamps, bucketed in memory) once per requested period - a small, fixed, disclosed
// bound, the same "bounded fan-out" idiom partner-review-evidence.ts already establishes.
//
// Two claims from the spec's own "Show, where supported" list have NO real source backing anywhere in
// this product and are deliberately OMITTED (never fabricated) - see extraLimitations below:
//   - "roster evolution": Partners has no historical/point-in-time roster snapshot per period.
//   - true "account/platform evolution" (a follower-count trend): Analytics' own platform view exposes
//     only each account's single LATEST snapshot, never a history of snapshots.
// No "programme phase"/milestone entity exists anywhere in this product either - none is invented here.
const MAX_PERIODS = 6;

function parsePeriods(raw: string | undefined): { periods: ReviewPeriod[]; requestedCount: number; droppedCount: number } {
  if (!raw) return { periods: [], requestedCount: 0, droppedCount: 0 };
  const keys = [...new Set(raw.split(",").map((k) => k.trim()).filter((k) => k.length > 0))];
  const valid = keys.map((k) => derivePeriod(k)).filter((p): p is ReviewPeriod => p !== null);
  const sorted = [...valid].sort((a, b) => (a.periodKey < b.periodKey ? -1 : a.periodKey > b.periodKey ? 1 : 0));
  const bounded = sorted.slice(0, MAX_PERIODS);
  return { periods: bounded, requestedCount: keys.length, droppedCount: keys.length - bounded.length };
}

export async function runLongPeriodPartnerProgrammeReport(actor: ActorContext, appliedFilters: AppliedReportFilters): Promise<ReportsServiceResult<ReportResult>> {
  const generatedAt = new Date().toISOString();
  const partnerRef = appliedFilters.partnerRef;
  if (!partnerRef) return reportsInvalidInputResult("Long-Period Partner Programme requires a partnerRef filter - a bounded multi-period trend is only ever computed for one Partner at a time.");

  const { periods, requestedCount, droppedCount } = parsePeriods(appliedFilters.periods);
  if (periods.length === 0) return reportsInvalidInputResult(`Long-Period Partner Programme requires a "periods" filter: a comma-separated list of 1-${MAX_PERIODS} valid YYYY-MM period keys.`);

  const partner = await getPartner(actor, partnerRef);
  if (!partner.ok) return mapSourceError(partner);
  const partnerDisplayName = partner.data.displayName;

  // Review evidence - ONE bounded listPartnerReviewHeads call PER requested period, then ONE bounded
  // getPartnerReview call for each finalized head found (both capped at MAX_PERIODS, never unbounded).
  const production: ReportRow[] = [];
  const compliance: ReportRow[] = [];
  const performance: ReportRow[] = [];
  const reviewByPeriod = new Map<string, { hasFinalizedReview: boolean; hasComplianceEvidence: boolean | null; hasPerformanceEvidence: boolean | null }>();
  let latestFinalizedAt: string | null = null;
  let finalizedReviewCount = 0;

  for (const period of periods) {
    const headsResult = await listPartnerReviewHeads(actor, { limit: 1, partnerRef, periodKey: period.periodKey });
    if (!headsResult.ok) return mapSourceError(headsResult);
    const head = headsResult.data.heads.find((h) => h.currentFinalizedVersion !== null) ?? null;
    if (!head) {
      reviewByPeriod.set(period.periodKey, { hasFinalizedReview: false, hasComplianceEvidence: null, hasPerformanceEvidence: null });
      continue;
    }
    finalizedReviewCount++;
    const detail = await getPartnerReview(actor, head.reviewRef, { version: head.currentFinalizedVersion! });
    if (!detail.ok || !detail.data.selectedVersion) {
      reviewByPeriod.set(period.periodKey, { hasFinalizedReview: true, hasComplianceEvidence: null, hasPerformanceEvidence: null });
      continue;
    }
    const version = detail.data.selectedVersion;
    if (version.finalizedAt && (latestFinalizedAt === null || version.finalizedAt > latestFinalizedAt)) latestFinalizedAt = version.finalizedAt;
    const hasCompliance = version.snapshot.compliance.assignments.length > 0;
    const hasPerformance = version.snapshot.performance.records.length > 0;
    reviewByPeriod.set(period.periodKey, { hasFinalizedReview: true, hasComplianceEvidence: hasCompliance, hasPerformanceEvidence: hasPerformance });
    production.push({ periodKey: period.periodKey, assignmentsIncluded: version.snapshot.production.assignments.length });
    compliance.push({ periodKey: period.periodKey, assignmentsIncluded: version.snapshot.compliance.assignments.length });
    performance.push({ periodKey: period.periodKey, recordCount: version.snapshot.performance.records.length });
  }

  // Analytics - exactly TWO bounded platform reads total (never per-period), with the already-bounded
  // matched content/account rows bucketed in memory into the requested periods by their own real
  // publishedAt/snapshotAt date.
  let analyticsTruncated = false;
  let latestSourceAt: string | null = null;
  const outputByPeriod = new Map<string, ReportRow>();
  for (const period of periods) outputByPeriod.set(period.periodKey, { periodKey: period.periodKey });

  const viewsByPeriodPlatform: Record<PlatformViewId, Map<string, number>> = { instagram: new Map(), youtube: new Map() };
  const engagementByPeriodPlatform: Record<PlatformViewId, Map<string, number>> = { instagram: new Map(), youtube: new Map() };
  const accountCoverageByPeriodPlatform: Record<PlatformViewId, Set<string>> = { instagram: new Set(), youtube: new Set() };

  for (const platform of PLATFORM_VIEW_IDS) {
    const view = await getPlatformAnalyticsView(actor, platform);
    if (!view.ok) return mapSourceError(view);
    if (view.data.coverage.contentTruncated || view.data.coverage.channelTruncated) analyticsTruncated = true;

    const matched = view.data.publishedContent.rows.filter((row) => row.matchState === "MATCHED" && row.partnerLabel === partnerDisplayName);
    for (const row of matched) {
      const date = row.publishedAt ? toUtcDate(row.publishedAt) : null;
      const period = date ? periods.find((p) => date >= p.periodStart && date <= p.periodEnd) : undefined;
      if (row.publishedAt && (latestSourceAt === null || row.publishedAt > latestSourceAt)) latestSourceAt = row.publishedAt;
      if (!period) continue;
      const entry = outputByPeriod.get(period.periodKey)!;
      entry[`publishedContentCount_${platform}`] = (Number(entry[`publishedContentCount_${platform}`]) || 0) + 1;
      if (row.views !== null) viewsByPeriodPlatform[platform].set(period.periodKey, (viewsByPeriodPlatform[platform].get(period.periodKey) ?? 0) + row.views);
      if (row.engagement !== null) engagementByPeriodPlatform[platform].set(period.periodKey, (engagementByPeriodPlatform[platform].get(period.periodKey) ?? 0) + row.engagement);
    }

    const accounts = view.data.partnerAccounts.rows.filter((row) => row.partnerLabel === partnerDisplayName);
    for (const account of accounts) {
      const date = toUtcDate(account.snapshotAt);
      const period = date ? periods.find((p) => date >= p.periodStart && date <= p.periodEnd) : undefined;
      if (period) accountCoverageByPeriodPlatform[platform].add(period.periodKey);
      if (account.snapshotAt > (latestSourceAt ?? "")) latestSourceAt = account.snapshotAt;
    }
  }

  for (const period of periods) {
    const entry = outputByPeriod.get(period.periodKey)!;
    for (const platform of PLATFORM_VIEW_IDS) {
      entry[`views_${platform}`] = viewsByPeriodPlatform[platform].get(period.periodKey) ?? null;
      entry[`engagement_${platform}`] = engagementByPeriodPlatform[platform].get(period.periodKey) ?? null;
      entry[`accountSnapshotInPeriod_${platform}`] = accountCoverageByPeriodPlatform[platform].has(period.periodKey);
      if (entry[`publishedContentCount_${platform}`] === undefined) entry[`publishedContentCount_${platform}`] = 0;
    }
    const review = reviewByPeriod.get(period.periodKey) ?? { hasFinalizedReview: false, hasComplianceEvidence: null, hasPerformanceEvidence: null };
    entry.hasFinalizedReview = review.hasFinalizedReview;
    entry.hasComplianceEvidence = review.hasComplianceEvidence;
    entry.hasPerformanceEvidence = review.hasPerformanceEvidence;
  }

  const rows: ReportRow[] = periods.map((period) => outputByPeriod.get(period.periodKey)!);

  const periodCoverage: ReportRow[] = periods.map((period) => {
    const entry = outputByPeriod.get(period.periodKey)!;
    const hasAnalyticsEvidence = PLATFORM_VIEW_IDS.some((platform) => (Number(entry[`publishedContentCount_${platform}`]) || 0) > 0 || entry[`accountSnapshotInPeriod_${platform}`] === true);
    return { periodKey: period.periodKey, hasReviewEvidence: entry.hasFinalizedReview === true, hasAnalyticsEvidence };
  });

  function leaderFor(metricPrefix: "views" | "engagement", platform: PlatformViewId): string | null {
    let best: { periodKey: string; value: number } | null = null;
    for (const period of periods) {
      const raw = outputByPeriod.get(period.periodKey)![`${metricPrefix}_${platform}`];
      const value = typeof raw === "number" ? raw : Number.NaN;
      if (!Number.isFinite(value) || value <= 0) continue;
      if (!best || value > best.value) best = { periodKey: period.periodKey, value };
    }
    return best?.periodKey ?? null;
  }

  const metrics: Record<string, number | string | null> = {
    requestedPeriodCount: requestedCount,
    coveredPeriodCount: periods.length,
    droppedPeriodCount: droppedCount,
    finalizedReviewCount,
  };
  for (const platform of PLATFORM_VIEW_IDS) {
    metrics[`leaderPeriodByViews_${platform}`] = leaderFor("views", platform);
    metrics[`leaderPeriodByEngagement_${platform}`] = leaderFor("engagement", platform);
  }

  const evidenceCutoff = [latestFinalizedAt, latestSourceAt].filter((v): v is string => v !== null).sort().pop() ?? generatedAt;
  const truncated = analyticsTruncated || droppedCount > 0;

  return {
    ok: true,
    data: buildReportResult({
      reportId: "long_period_partner_programme",
      generatedAt,
      evidenceCutoff,
      appliedFilters,
      scopeSummary: {
        basis: "actor-scope (getPartner + listPartnerReviewHeads/getPartnerReview + getPlatformAnalyticsView, one bounded read per requested period)",
        note: `Scoped to Partner "${partnerDisplayName}" across ${periods.length} requested period(s).`,
      },
      metrics,
      rows,
      sections: { production, compliance, performance, periodCoverage },
      extraLimitations: [
        `Bounded to a maximum of ${MAX_PERIODS} explicit period keys per request (never an open-ended date range) - this run requested ${requestedCount} and covered ${periods.length}${droppedCount > 0 ? `, dropping ${droppedCount} beyond the bound` : ""}.`,
        "Roster evolution is not shown: Partners has no historical/point-in-time roster snapshot per period - only current Partner state is queryable, so a genuine period-by-period roster reconstruction is not possible without fabrication.",
        "Account/platform EVOLUTION (a follower-count trend period-over-period) is not shown: Analytics' own platform view intentionally exposes only each account's single latest snapshot, never a history of snapshots. accountSnapshotInPeriod_<platform> only discloses whether that single latest snapshot's own timestamp happens to fall inside a requested period - a coverage check, not a trend.",
        "No programme-phase or milestone entity exists anywhere in this product - none is fabricated here.",
        "Output-by-period and per-period Views/Engagement are drawn only from each platform's own bounded most-recent-content window (the same bound every other Analytics-sourced Reports family uses) - a requested period whose matched content falls outside that recent window reports zero/unavailable, indistinguishable from a period with genuinely no evidence; this is a real absence-of-evidence limitation, not a bug.",
        "Leaders (leaderPeriodByViews_<platform> / leaderPeriodByEngagement_<platform>) each rank periods by exactly ONE explicit metric at a time, per platform - never a blended cross-metric or cross-platform leader.",
      ],
      truncated,
      rowCount: rows.length,
      provenance: [
        { sourceModule: "partners", sourceFunction: "getPartner", recordCount: 1 },
        { sourceModule: "partner_reviews", sourceFunction: "listPartnerReviewHeads", recordCount: periods.length, scanned: periods.length },
        { sourceModule: "partner_reviews", sourceFunction: "getPartnerReview", recordCount: finalizedReviewCount, scanned: finalizedReviewCount },
        ...PLATFORM_VIEW_IDS.map((platform) => ({ sourceModule: "analytics", sourceFunction: "getPlatformAnalyticsView", recordCount: rows.filter((r) => (Number(r[`publishedContentCount_${platform}`]) || 0) > 0).length })),
      ],
    }),
  };
}
