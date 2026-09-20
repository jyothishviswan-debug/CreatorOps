// Step 12F: the pure composition math behind the Partners Analytics workspace
// (partners-workspace-service.ts is the async orchestration; nothing here
// touches Firestore, a clock or an ActorContext, so every branch is directly
// Vitest-testable with synthetic input).
//
// It BUILDS ON the accepted 12D/12E helpers - every per-platform / per-metric
// number is produced by aggregatePartnerKpis (partner-view-metrics.ts, itself
// built on aggregatePlatformKpis) and every month decision by reporting-month.ts
// - it does not fork their aggregation. Semantics carried over unchanged:
//   - missing != zero: a metric never once source-reported stays `null`
//     (rendered "Unavailable"), a Partner with no record in the month has NO
//     numbers at all (never 0);
//   - Engagement is the source-reported `engagement` field ONLY;
//   - Views are platform-NATIVE: Instagram Views and YouTube Views are separate
//     columns / matrices and are never summed;
//   - each Partner is evaluated INDEPENDENTLY from its OWN records: there is no
//     overall score, no rating, no blended or weighted ranking, no cross-Partner
//     total of any metric, no follower total across accounts and no Reach /
//     Watch Time / Impressions / Shares / Saves anywhere in these shapes;
//   - a monthly trend is a per-Partner, per-platform series: a month with no
//     value is a GAP (null) - never interpolated, never zero-filled.
import { aggregatePartnerKpis, platformLabelOf, platformsForSelection, type PartnerPlatformCard, type PartnerViewSelection } from "./partner-view-metrics";
import { forPlatform, isValidMetricValue, PLATFORM_VIEW_METRIC_LABELS, PLATFORM_VIEW_METRICS, type PlatformTrend, type PlatformTrendSeries, type PlatformViewId, type PlatformViewMetricId } from "./platform-view-metrics";
import { calendarWindow, classifyReportingPeriod, countExclusions, deriveAvailableMonths, filterRecordsToMonth, monthLabel, shortMonthLabel, addExclusions, MAX_MONTH_OPTIONS, type MonthExclusions } from "./reporting-month";
import type { AnalyticsChannelSourceRecordDoc, AnalyticsContentSourceRecordDoc } from "./types";

// ---- One Partner's bounded, platform-filtered record window --------------------------------------

export type PartnerRecordWindow = {
  content: AnalyticsContentSourceRecordDoc[];
  channel: AnalyticsChannelSourceRecordDoc[];
  // true when the bounded read stopped while a next page still existed.
  truncated: boolean;
};

// Belt and braces (same discipline as 12D/12E): only the selected platforms'
// records can ever be counted, even if a caller handed over a mixed window.
export function restrictWindowToSelection(window: PartnerRecordWindow, selection: PartnerViewSelection): PartnerRecordWindow {
  const platforms = platformsForSelection(selection);
  return {
    content: platforms.flatMap((platform) => forPlatform(window.content, platform)),
    channel: platforms.flatMap((platform) => forPlatform(window.channel, platform)),
    truncated: window.truncated,
  };
}

export function windowRecords(windows: PartnerRecordWindow[]): { reportingPeriod: { start: string; end: string } | null }[] {
  return windows.flatMap((window) => [...window.content, ...window.channel]);
}

// The months (newest first, bounded) with >= 1 valid record across the windows.
export function availableMonthsOf(windows: PartnerRecordWindow[]): string[] {
  return deriveAvailableMonths(windowRecords(windows), MAX_MONTH_OPTIONS);
}

// Records that can never be placed in a month, per reason, across the windows.
export function exclusionsOf(windows: PartnerRecordWindow[]): MonthExclusions {
  return windows.reduce<MonthExclusions>((acc, window) => addExclusions(acc, countExclusions([...window.content, ...window.channel])), { noPeriod: 0, unparseable: 0, spans: 0 });
}

export function sliceWindowToMonth(window: PartnerRecordWindow, month: string): { content: AnalyticsContentSourceRecordDoc[]; channel: AnalyticsChannelSourceRecordDoc[] } {
  return { content: filterRecordsToMonth(window.content, month), channel: filterRecordsToMonth(window.channel, month) };
}

// ---- Coverage --------------------------------------------------------------------------------------

export type PartnerCoverageState = "content_and_channel" | "content_only" | "channel_only" | "no_data";

export const COVERAGE_STATE_LABELS: Record<PartnerCoverageState, string> = {
  content_and_channel: "Content and channel data",
  content_only: "Content data",
  channel_only: "Channel snapshots only",
  no_data: "Unavailable",
};

export function coverageStateOf(contentRecords: number, channelRecords: number): PartnerCoverageState {
  if (contentRecords > 0 && channelRecords > 0) return "content_and_channel";
  if (contentRecords > 0) return "content_only";
  if (channelRecords > 0) return "channel_only";
  return "no_data";
}

export function hasMonthData(state: PartnerCoverageState): boolean {
  return state !== "no_data";
}

// "4 of 6 selected Partners have Analytics data for August 2026" - x is the
// number of selected Partners with >= 1 in-month valid record within the
// platform selection, y the number of selected Partners (never fewer: a Partner
// without data is counted in y, not dropped).
export function coverageSummaryText(params: { selected: number; withData: number; month: string; platform: PartnerViewSelection }): string {
  const { selected, withData, month, platform } = params;
  const platformPhrase = platform === "all" ? "" : `${platformLabelOf(platform)} `;
  return `${withData} of ${selected} selected Partner${selected === 1 ? "" : "s"} ${selected === 1 || withData === 1 ? "has" : "have"} ${platformPhrase}Analytics data for ${monthLabel(month)}`;
}

// ---- Comparison (2+ Partners) --------------------------------------------------------------------------

export type ComparisonMetricCell = {
  // `null` = not source-reported (Unavailable) - never 0.
  total: number | null;
  recordsWithValue: number;
  recordsTotal: number;
};

export type ComparisonRowDto = {
  displayName: string;
  // Same-origin, opaque link to this Partner's own drill-down (month + platform carried).
  analyticsHref: string;
  coverage: { state: PartnerCoverageState; label: string; contentRecords: number; channelRecords: number; truncated: boolean };
  // In-month source content records; `null` (Unavailable) when there are none - never 0.
  publishedContent: number | null;
  // Native, per-platform Views - `null` cell object = that platform is not part of the platform filter.
  instagramViews: ComparisonMetricCell | null;
  youtubeViews: ComparisonMetricCell | null;
  engagement: ComparisonMetricCell;
  likes: ComparisonMetricCell;
  comments: ComparisonMetricCell;
  // Freshness: the Partner's latest channel snapshot IMPORT date and reporting period (never a follower count).
  latestSnapshot: { importedAt: string; reportingPeriod: { start: string; end: string } | null } | null;
};

export type ComparisonDto = {
  // The Views columns that exist for the current platform filter, in fixed order.
  viewsPlatforms: PlatformViewId[];
  rows: ComparisonRowDto[];
};

function emptyCell(): ComparisonMetricCell {
  return { total: null, recordsWithValue: 0, recordsTotal: 0 };
}

// The Partner's most recently IMPORTED channel snapshot in its window (all
// months): a freshness indicator - deterministic (newest import, then sourceRef).
export function latestChannelSnapshot(channel: AnalyticsChannelSourceRecordDoc[]): ComparisonRowDto["latestSnapshot"] {
  let best: AnalyticsChannelSourceRecordDoc | null = null;
  for (const record of channel) {
    if (!best || record.createdAt > best.createdAt || (record.createdAt === best.createdAt && record.sourceRef < best.sourceRef)) best = record;
  }
  return best ? { importedAt: best.createdAt, reportingPeriod: best.reportingPeriod } : null;
}

export function buildComparisonRow(params: { displayName: string; analyticsHref: string; window: PartnerRecordWindow; month: string | null; selection: PartnerViewSelection }): ComparisonRowDto {
  const { displayName, analyticsHref, month, selection } = params;
  const window = restrictWindowToSelection(params.window, selection);
  const inMonth = month ? sliceWindowToMonth(window, month) : { content: [], channel: [] };
  const state = coverageStateOf(inMonth.content.length, inMonth.channel.length);

  // The accepted per-platform / per-metric aggregation, run over THIS Partner's
  // in-month records only.
  const kpis = aggregatePartnerKpis(inMonth.content, selection);
  const viewsOf = (platform: PlatformViewId): ComparisonMetricCell | null => {
    const entry = kpis.views.byPlatform.find((item) => item.platform === platform);
    return entry ? { total: entry.total, recordsWithValue: entry.recordsWithValue, recordsTotal: entry.recordsTotal } : null;
  };
  const cellOf = (metric: "engagement" | "likes" | "comments"): ComparisonMetricCell => {
    const kpi = kpis[metric];
    return inMonth.content.length === 0 ? emptyCell() : { total: kpi.total, recordsWithValue: kpi.recordsWithValue, recordsTotal: kpi.recordsTotal };
  };

  return {
    displayName,
    analyticsHref,
    coverage: { state, label: COVERAGE_STATE_LABELS[state], contentRecords: inMonth.content.length, channelRecords: inMonth.channel.length, truncated: window.truncated },
    publishedContent: inMonth.content.length > 0 ? inMonth.content.length : null,
    instagramViews: viewsOf("instagram"),
    youtubeViews: viewsOf("youtube"),
    engagement: cellOf("engagement"),
    likes: cellOf("likes"),
    comments: cellOf("comments"),
    latestSnapshot: latestChannelSnapshot(window.channel),
  };
}

// ---- Monthly trend (single Partner, per platform) ---------------------------------------------------------

// The latest month among the records that CAN be placed in a month (null = none).
export function latestMonthOf(records: { reportingPeriod: { start: string; end: string } | null }[]): string | null {
  return deriveAvailableMonths(records, 1)[0] ?? null;
}

// ONE platform's monthly series for ONE Partner over a continuous 12-month
// calendar window ending at `axisEnd` (the Partner's latest month with content
// data). Only records with a usable single-month period contribute; a month with
// no source-reported value is a null GAP (the line breaks there - nothing is
// interpolated or zero-filled). Leading/trailing months without any plotted value
// are trimmed; a metric reported in fewer than two months is not plotted and is
// disclosed (`omittedMetrics`), exactly like the accepted 12D trend.
export function buildMonthlyPlatformTrend(contentRecords: AnalyticsContentSourceRecordDoc[], platform: PlatformViewId, axisEnd: string | null, monthsWindow = MAX_MONTH_OPTIONS): PlatformTrend {
  if (!axisEnd) return { periods: [], series: [], omittedMetrics: [] };
  const axis = calendarWindow(axisEnd, monthsWindow);
  const sums = new Map<string, Partial<Record<PlatformViewMetricId, number>>>();
  for (const record of forPlatform(contentRecords, platform)) {
    const classified = classifyReportingPeriod(record.reportingPeriod);
    if (classified.kind !== "month" || !axis.includes(classified.month)) continue;
    const entry = sums.get(classified.month) ?? {};
    for (const metric of PLATFORM_VIEW_METRICS) {
      const value = record[metric];
      if (isValidMetricValue(value)) entry[metric] = (entry[metric] ?? 0) + value;
    }
    sums.set(classified.month, entry);
  }

  const series: PlatformTrendSeries[] = [];
  const omittedMetrics: PlatformViewMetricId[] = [];
  for (const metric of PLATFORM_VIEW_METRICS) {
    const values = axis.map((month) => sums.get(month)?.[metric] ?? null);
    const realPoints = values.filter((value) => value !== null).length;
    if (realPoints >= 2) series.push({ metric, label: PLATFORM_VIEW_METRIC_LABELS[metric], values });
    else if (realPoints === 1) omittedMetrics.push(metric);
  }
  if (series.length === 0) return { periods: [], series: [], omittedMetrics };

  // Trim leading/trailing months where no plotted series has a value; middle gaps stay.
  const hasValue = axis.map((_, index) => series.some((s) => s.values[index] !== null));
  const first = hasValue.indexOf(true);
  const last = hasValue.lastIndexOf(true);
  return {
    periods: axis.slice(first, last + 1).map((month) => ({ key: `m:${month}`, label: shortMonthLabel(month) })),
    series: series.map((s) => ({ ...s, values: s.values.slice(first, last + 1) })),
    omittedMetrics,
  };
}

// One card per INCLUDED platform (a platform with no data is still a card), each
// with ITS OWN monthly trend on the SAME calendar axis - never a merged series.
// Feeds the single-Partner month view in place of the 12D per-period cards.
export function buildMonthlyPartnerPlatformCards(contentRecords: AnalyticsContentSourceRecordDoc[], selection: PartnerViewSelection): PartnerPlatformCard[] {
  const platforms = platformsForSelection(selection);
  const axisEnd = latestMonthOf(platforms.flatMap((platform) => forPlatform(contentRecords, platform)));
  return platforms.map((platform) => {
    const records = forPlatform(contentRecords, platform);
    return { platform, label: platformLabelOf(platform), hasData: records.length > 0, recordCount: records.length, trend: buildMonthlyPlatformTrend(contentRecords, platform, axisEnd), trendBasis: "month" as const };
  });
}

// ---- Multi-Partner month x Partner matrix ---------------------------------------------------------------------

export type TrendMatrixDto = {
  // null = the metric summed across the selected platforms (Engagement / Likes / Comments on All);
  // a platform id = that platform's own native series (Views are ALWAYS per platform).
  platform: PlatformViewId | null;
  metric: PlatformViewMetricId;
  title: string;
  months: { month: string; label: string }[];
  partners: { displayName: string }[];
  // cells[monthIndex][partnerIndex]; `null` = not source-reported (rendered "—", announced Unavailable).
  cells: (number | null)[][];
};

function metricSum(records: AnalyticsContentSourceRecordDoc[], metric: PlatformViewMetricId): number | null {
  let sum: number | null = null;
  for (const record of records) {
    const value = record[metric];
    if (isValidMetricValue(value)) sum = (sum ?? 0) + value;
  }
  return sum;
}

// ONE metric at a time, over the latest <= 12 available months (oldest first) x
// the selected Partners. Views on `All` are two SEPARATE matrices (native
// counts are never combined); every other metric is one matrix summed over the
// selected platforms (a shared unit, as on the accepted 12E KPI row). Each cell
// comes from that Partner's OWN in-month records: nothing is totalled across
// Partners.
export function buildTrendMatrices(params: { partners: { displayName: string; window: PartnerRecordWindow }[]; selection: PartnerViewSelection; metric: PlatformViewMetricId; months: string[] }): TrendMatrixDto[] {
  const { partners, selection, metric } = params;
  const months = [...params.months].sort();
  const platforms = platformsForSelection(selection);
  const label = PLATFORM_VIEW_METRIC_LABELS[metric];

  const build = (platform: PlatformViewId | null, platformSet: PlatformViewId[], title: string): TrendMatrixDto => ({
    platform,
    metric,
    title,
    months: months.map((month) => ({ month, label: shortMonthLabel(month) })),
    partners: partners.map((partner) => ({ displayName: partner.displayName })),
    cells: months.map((month) =>
      partners.map((partner) => {
        const inMonth = filterRecordsToMonth(
          platformSet.flatMap((p) => forPlatform(partner.window.content, p)),
          month,
        );
        return metricSum(inMonth, metric);
      }),
    ),
  });

  if (metric === "views") return platforms.map((platform) => build(platform, [platform], `${platformLabelOf(platform)} Views`));
  return [build(null, platforms, selection === "all" ? `${label} (all platforms)` : `${platformLabelOf(selection)} ${label}`)];
}
