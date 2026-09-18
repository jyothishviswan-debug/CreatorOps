// Step 12B: the pure, dependency-free composition math behind the
// Analytics Overview page. Nothing here touches Firestore or an
// ActorContext - every branch is directly Vitest-testable with synthetic
// input (see overview-metrics.test.ts), same "extract the pure logic,
// leave DOM-rendered proof to Playwright E2E" discipline Step 11B
// established for Content's own workflow.ts. The async orchestration
// (gating, bounded fetch, calling these) lives in overview-service.ts.
import type { AnalyticsContentSourceRecordDoc, AnalyticsImportBatchDoc } from "./types";

export type PlatformMetricTotals = Record<string, Record<string, number | null>>;

const PLATFORM_ABBREVIATIONS: Record<string, string> = {
  instagram: "IG",
  youtube: "YT",
  tiktok: "TT",
};

// Display-only shorthand for a platform id - never alters the stored
// value, mirrors content/format.ts's platformLabel idiom (title-case)
// for the cases this table doesn't cover.
export function platformAbbreviation(platform: string): string {
  return PLATFORM_ABBREVIATIONS[platform] ?? (platform.length > 0 ? platform.slice(0, 2).toUpperCase() : platform);
}

export type MetricAggregateAcrossPlatforms = { sum: number | null; coveredPlatforms: string[]; missingPlatforms: string[] };

// Sums one metric across every platform present in `totals` - honestly
// tracks which platforms actually contributed a non-null value. The
// overall sum stays `null` (never `0`) when NOT ONE platform reported
// the metric at all, so "nobody reported this" is never confused with
// "everybody reported zero".
export function sumMetricAcrossPlatforms(totals: PlatformMetricTotals, metric: string): MetricAggregateAcrossPlatforms {
  const platforms = Object.keys(totals).sort();
  const coveredPlatforms: string[] = [];
  const missingPlatforms: string[] = [];
  let sum = 0;
  for (const platform of platforms) {
    const value = totals[platform]?.[metric];
    if (value === null || value === undefined) missingPlatforms.push(platform);
    else {
      sum += value;
      coveredPlatforms.push(platform);
    }
  }
  return { sum: coveredPlatforms.length > 0 ? sum : null, coveredPlatforms, missingPlatforms };
}

// "389 IG · 426 YT" style breakdown - built from the REAL per-platform
// counts, never a re-derived guess.
export function formatPublishedContentHint(countsByPlatform: Record<string, number>): string {
  const platforms = Object.keys(countsByPlatform).sort();
  if (platforms.length === 0) return "No source content records yet";
  return platforms.map((platform) => `${countsByPlatform[platform]} ${platformAbbreviation(platform)}`).join(" · ");
}

// "Stale batches" - Section 8's own real staleness definition: a batch
// whose terminal status is FAILED or COMPLETED_WITH_ERRORS. Documented
// here as the one, exact, disclosed rule (see the Overview composition
// report) rather than an invented age-based heuristic.
export function computeStaleBatchCount(batches: Pick<AnalyticsImportBatchDoc, "status">[]): number {
  return batches.filter((b) => b.status === "FAILED" || b.status === "COMPLETED_WITH_ERRORS").length;
}

export type CampaignLinkageBadge = "Current" | "Partial" | "Not started";

// Derived entirely from the SAME bounded content-record fetch the KPIs
// already use - never a new Campaign-domain read. "Not started": zero
// matched records yet. "Partial": at least one matched AND at least one
// unmatched/ambiguous record in scope. "Current": matched records exist
// and none are unmatched/ambiguous.
export function computeCampaignLinkageBadge(matchedCount: number, exceptionCount: number): CampaignLinkageBadge {
  if (matchedCount === 0) return "Not started";
  return exceptionCount > 0 ? "Partial" : "Current";
}

// The one hard rule the task doc requires: a missing/null freshness date
// must never read "Current". Any real date (however old) reads "Current"
// - no invented age-based staleness heuristic.
export function computeFreshnessBadge(dateIso: string | null): "Current" | "No data" {
  return dateIso ? "Current" : "No data";
}

export type DonutMetricInput = { label: string; sum: number | null };
export type DonutSegmentsResult = { segments: { label: string; value: number }[]; total: number; omittedLabels: string[] };

// Shared "sum several supported metrics into one donut, never draw a
// fabricated arc for a metric nobody reported" builder. A metric whose
// aggregate is `null` (never once source-reported in scope) is OMITTED
// from `segments` entirely - rendering it as a 0-length arc would
// misrepresent "never reported" as "reported as zero". A metric that WAS
// reported and genuinely sums to a real 0 stays IN `segments` (value 0
// still renders in the ring's own legend row) - "missing" and "reported
// as zero" are never conflated in either direction.
export function buildAvailableDonutSegments(inputs: DonutMetricInput[]): DonutSegmentsResult {
  const available = inputs.filter((input): input is { label: string; sum: number } => input.sum !== null);
  const segments = available.map((input) => ({ label: input.label, value: input.sum }));
  const omittedLabels = inputs.filter((input) => input.sum === null).map((input) => input.label);
  const total = segments.reduce((acc, s) => acc + s.value, 0);
  return { segments, total, omittedLabels };
}

export type TrendPoint = { periodLabel: string; value: number };

// Buckets one metric, for one platform, across an already-scoped set of
// content records - by the record's own reportingPeriod when present
// (real, never invented), else by the record's own createdAt year-month
// (also real). Returns `null` (never a fabricated flat/zero line) when:
//   - not one record on this platform ever reported this metric, or
//   - only a single distinct period bucket exists.
// The second rule exists because the shared TrendGrid component (see
// src/ui/Overview.tsx) always computes a "vs previous point" delta from
// `values.at(-1)`/`values.at(-2)` - a genuine one-point series would make
// that division produce `NaN%`, a real, disclosed limitation of the
// frozen shared component this call deliberately avoids triggering,
// without modifying that shared file - see the Step 12B completion
// report's own "trend series" note.
export function buildPlatformMetricTrend(
  records: Pick<AnalyticsContentSourceRecordDoc, "platform" | "createdAt" | "reportingPeriod" | "views" | "engagement" | "likes" | "comments">[],
  platform: string,
  metric: "views" | "engagement" | "likes" | "comments",
): TrendPoint[] | null {
  const buckets = new Map<string, number>();
  let sawAny = false;
  for (const record of records) {
    if (record.platform !== platform) continue;
    const value = record[metric];
    if (value === null || value === undefined) continue;
    sawAny = true;
    const label = record.reportingPeriod ? `${record.reportingPeriod.start}–${record.reportingPeriod.end}` : record.createdAt.slice(0, 7);
    buckets.set(label, (buckets.get(label) ?? 0) + value);
  }
  if (!sawAny) return null;
  const points = [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([periodLabel, value]) => ({ periodLabel, value }));
  return points.length >= 2 ? points : null;
}

// Ingestion Exceptions rows: choose only the categories the ACTUAL
// fetched data supports - never pads to a fixed row count. `staleBatches`
// is included only when > 0, matching the same "never a manufactured
// row" discipline as the other three.
export type IngestionExceptionCategory = { title: string; detail: string; count: number; href: string };
export function buildIngestionExceptionCategories(params: {
  unmatchedContent: number;
  unmatchedChannel: number;
  ambiguousTotal: number;
  staleBatches: number;
}): IngestionExceptionCategory[] {
  const rows: IngestionExceptionCategory[] = [];
  if (params.unmatchedContent > 0) rows.push({ title: "Unlinked content", detail: "Resolve", count: params.unmatchedContent, href: "/analytics/explorer?matchState=UNMATCHED&recordKind=content" });
  if (params.unmatchedChannel > 0) rows.push({ title: "Unmatched Partner Accounts", detail: "Resolve", count: params.unmatchedChannel, href: "/analytics/explorer?matchState=UNMATCHED&recordKind=channel" });
  if (params.ambiguousTotal > 0) rows.push({ title: "Ambiguous records", detail: "Review", count: params.ambiguousTotal, href: "/analytics/explorer?matchState=AMBIGUOUS&recordKind=channel" });
  if (params.staleBatches > 0) rows.push({ title: "Stale import batches", detail: "Review", count: params.staleBatches, href: "/analytics/import-history" });
  return rows;
}
