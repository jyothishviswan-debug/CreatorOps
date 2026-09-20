import type { PlatformTrend, PlatformTrendSeries, PlatformViewMetricId } from "@/server/analytics/platform-view-metrics";
import type { PartnerHistoryMonthRowDto } from "@/server/partner-reviews/partner-history-model";
import { monthLabel } from "@/server/partner-reviews/ui-params";

// Step 13B: PURE view-model helpers of the Partner-wise history page.

export const HISTORY_METRICS: readonly PlatformViewMetricId[] = ["views", "engagement", "likes", "comments"];
export const HISTORY_METRIC_LABELS: Record<PlatformViewMetricId, string> = { views: "Views", engagement: "Engagement (source-reported)", likes: "Likes", comments: "Comments" };

// Platforms with any verified Analytics evidence in the window, in a stable order (Instagram, YouTube, then any other).
export function platformsInHistory(rows: readonly PartnerHistoryMonthRowDto[]): string[] {
  const found = new Set<string>();
  for (const row of rows) for (const platform of Object.keys(row.row?.summary?.performance.perPlatform ?? {})) found.add(platform);
  const preferred = ["instagram", "youtube"].filter((platform) => found.has(platform));
  return [...preferred, ...[...found].filter((platform) => !preferred.includes(platform)).sort()];
}

// One PlatformTrend PER platform (never a combined line): the window's months oldest -> newest, and per
// metric the platform's native value for that month, or null where there is no review / the source did not
// report it. A gap stays a gap (PlatformTrendGrid draws it as one). Only a metric reported in at least two
// months is plotted - a single dot is not a trend - the rest are disclosed in `omittedMetrics`, and every
// value is also present as text in the month tables.
export function buildPlatformTrend(rows: readonly PartnerHistoryMonthRowDto[], platform: string): PlatformTrend {
  const ordered = [...rows].reverse();
  const periods = ordered.map((row) => ({ key: row.periodKey, label: monthLabel(row.periodKey) }));
  const series: PlatformTrendSeries[] = [];
  const omittedMetrics: PlatformViewMetricId[] = [];
  for (const metric of HISTORY_METRICS) {
    const values = ordered.map((row) => row.row?.summary?.performance.perPlatform[platform]?.[metric] ?? null);
    const real = values.filter((value) => value !== null).length;
    if (real >= 2) series.push({ metric, label: HISTORY_METRIC_LABELS[metric], values });
    else if (real === 1) omittedMetrics.push(metric);
  }
  return { periods, series, omittedMetrics };
}
