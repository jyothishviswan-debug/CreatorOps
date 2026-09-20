// Step 12D: the pure, dependency-light composition math behind the separate
// Instagram / YouTube Analytics views (platform-view-service.ts is the async
// orchestration; nothing here touches Firestore or an ActorContext, so every
// branch is directly Vitest-testable with synthetic input - same "extract
// the pure logic" discipline as overview-metrics.ts, which is deliberately
// NOT modified: these views are a NEW composition next to the accepted
// Overview, never a change to it).
//
// Every function takes an ALREADY scope-constrained, bounded set of source
// records (the caller fetched them through the accepted, scoped
// listAnalyticsSourceRecords) and additionally filters to ONE platform
// itself - belt and braces, so a mixed-platform input can never leak a
// second platform into a platform view even if a caller forgot the server
// filter.
//
// Semantics carried over unchanged from the accepted Overview:
//   - missing != zero: a metric never once source-reported stays `null`;
//   - Engagement is the source-reported `engagement` field ONLY, never
//     derived from likes + comments;
//   - unsupported != estimated: no Reach / Shares / Saves / Watch Time /
//     Impressions / subscriber growth key exists anywhere in these shapes;
//   - profile followers is a point-in-time SNAPSHOT per Partner Account -
//     never summed across accounts into a platform total (no such field
//     exists), never presented as growth.
import { formatCompact, type KpiDatum } from "@/features/shared/types";
import { normalizePlatformIdentifier } from "@/server/shared/platform";

import { aggregateFreshnessByPlatform, aggregateIngestionExceptionCounts, aggregatePlatformTotals } from "./read-models";
import type { AnalyticsChannelSourceRecordDoc, AnalyticsContentSourceRecordDoc } from "./types";

// ---- Platform identity ------------------------------------------------------

// The only two platforms these dedicated views exist for. Anything else
// (tiktok, garbage, a near-miss like "insta") is rejected rather than
// rendered as an arbitrary platform page.
export const PLATFORM_VIEW_IDS = ["instagram", "youtube"] as const;
export type PlatformViewId = (typeof PLATFORM_VIEW_IDS)[number];

// Normalizes with the ONE shared platform-identifier contract
// (normalizePlatformIdentifier - trim + lowercase), then accepts only the
// closed set above.
export function parsePlatformViewId(input: unknown): PlatformViewId | null {
  if (typeof input !== "string") return null;
  const normalized = normalizePlatformIdentifier(input);
  return (PLATFORM_VIEW_IDS as readonly string[]).includes(normalized) ? (normalized as PlatformViewId) : null;
}

export const PLATFORM_VIEW_COPY: Record<PlatformViewId, { label: string; title: string; description: string; footnote: string }> = {
  instagram: {
    label: "Instagram",
    title: "Instagram Analytics",
    description: "Source-reported Instagram post metrics, profile snapshots and source quality within your authorized scope.",
    footnote: "Instagram reach is not in the verified metric registry and is never plotted here; source-reported metrics only.",
  },
  youtube: {
    label: "YouTube",
    title: "YouTube Analytics",
    description: "Source-reported YouTube video metrics, channel snapshots and source quality within your authorized scope.",
    footnote: "Only source-reported metrics from the verified metric registry are plotted here; nothing is estimated or derived.",
  },
};

// ---- Supported metrics ------------------------------------------------------

// The four content metrics these views show, in their frozen display order.
export const PLATFORM_VIEW_METRICS = ["views", "engagement", "likes", "comments"] as const;
export type PlatformViewMetricId = (typeof PLATFORM_VIEW_METRICS)[number];

export const PLATFORM_VIEW_METRIC_LABELS: Record<PlatformViewMetricId, string> = {
  views: "Views",
  engagement: "Engagement",
  likes: "Likes",
  comments: "Comments",
};

export function isValidMetricValue(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function forPlatform<T extends { platform: string }>(records: T[], platform: PlatformViewId): T[] {
  return records.filter((record) => normalizePlatformIdentifier(record.platform) === platform);
}

// ---- KPI aggregates -----------------------------------------------------------

export type PlatformMetricAggregate = {
  // Sum of source-reported values on this platform's records; `null` (never
  // 0) when not one record reported this metric.
  total: number | null;
  recordsWithValue: number;
  recordsTotal: number;
};

export type PlatformKpis = {
  publishedContent: number;
  views: PlatformMetricAggregate;
  engagement: PlatformMetricAggregate;
  likes: PlatformMetricAggregate;
  comments: PlatformMetricAggregate;
};

export function aggregatePlatformKpis(contentRecords: AnalyticsContentSourceRecordDoc[], platform: PlatformViewId): PlatformKpis {
  const records = forPlatform(contentRecords, platform);
  // Totals come from the accepted read-model aggregator (missing stays
  // null); the with-value counts are this view's own coverage disclosure.
  const totals = aggregatePlatformTotals(records.map((record) => ({ ...record, platform })))[platform] ?? {};
  const aggregate = (metric: PlatformViewMetricId): PlatformMetricAggregate => {
    const recordsWithValue = records.filter((record) => isValidMetricValue(record[metric])).length;
    const total = totals[metric];
    return { total: recordsWithValue > 0 && isValidMetricValue(total) ? total : null, recordsWithValue, recordsTotal: records.length };
  };
  return {
    publishedContent: records.length,
    views: aggregate("views"),
    engagement: aggregate("engagement"),
    likes: aggregate("likes"),
    comments: aggregate("comments"),
  };
}

// The frozen 5-slot KPI row: Published content, Views, Engagement, Likes,
// Comments. No Reach slot - Instagram Reach is not in the verified
// registry - and no derived slot of any kind.
export function buildPlatformKpiData(kpis: PlatformKpis): KpiDatum[] {
  const metricCard = (metric: PlatformViewMetricId, icon: KpiDatum["icon"]): KpiDatum => {
    const aggregate = kpis[metric];
    const label = PLATFORM_VIEW_METRIC_LABELS[metric];
    if (aggregate.total === null) return { icon, label, value: "Unavailable", hint: `No source-reported ${label} yet` };
    const coverage = aggregate.recordsWithValue === aggregate.recordsTotal ? `all ${aggregate.recordsTotal}` : `${aggregate.recordsWithValue} of ${aggregate.recordsTotal}`;
    return { icon, label, value: formatCompact(aggregate.total), hint: `source-reported · ${coverage} record${aggregate.recordsTotal === 1 ? "" : "s"}` };
  };

  const published: KpiDatum =
    kpis.publishedContent === 0
      ? { icon: "file", label: "Published content", value: "Unavailable", hint: "No source content records yet" }
      : { icon: "file", label: "Published content", value: formatCompact(kpis.publishedContent), hint: `${kpis.publishedContent} source content record${kpis.publishedContent === 1 ? "" : "s"}` };

  return [published, metricCard("views", "chart"), metricCard("engagement", "flag"), metricCard("likes", "check"), metricCard("comments", "mail")];
}

// ---- Native metric trend --------------------------------------------------------

export type PlatformTrendPeriod = { key: string; label: string };
export type PlatformTrendSeries = { metric: PlatformViewMetricId; label: string; values: (number | null)[] };
export type PlatformTrend = {
  periods: PlatformTrendPeriod[];
  series: PlatformTrendSeries[];
  // Metrics that were source-reported in fewer than two periods: not
  // plotted (a single dot is not a trend), disclosed instead.
  omittedMetrics: PlatformViewMetricId[];
};

export const MAX_TREND_PERIODS = 12;

type Bucket = { key: string; label: string; sortKey: string };

// Same real-never-invented bucketing rule as the accepted Overview's
// buildPlatformMetricTrend: the record's own reportingPeriod when present,
// else the record's own import month (createdAt) - and that fallback is
// labelled as an IMPORT month, never dressed up as a reporting period.
function bucketFor(record: Pick<AnalyticsContentSourceRecordDoc, "reportingPeriod" | "createdAt">): Bucket {
  if (record.reportingPeriod) {
    const { start, end } = record.reportingPeriod;
    return { key: `p:${start}|${end}`, label: `${start} – ${end}`, sortKey: `${start}|${end}` };
  }
  const month = record.createdAt.slice(0, 7);
  return { key: `m:${month}`, label: `Imported ${month}`, sortKey: `${month}-01|` };
}

// One shared period axis for all four metrics; a metric with no
// source-reported value in a period stays `null` there (a GAP, never 0).
export function buildPlatformTrend(contentRecords: AnalyticsContentSourceRecordDoc[], platform: PlatformViewId, maxPeriods = MAX_TREND_PERIODS): PlatformTrend {
  const records = forPlatform(contentRecords, platform);
  const buckets = new Map<string, Bucket & { sums: Partial<Record<PlatformViewMetricId, number>> }>();

  for (const record of records) {
    const bucket = bucketFor(record);
    const entry = buckets.get(bucket.key) ?? { ...bucket, sums: {} };
    for (const metric of PLATFORM_VIEW_METRICS) {
      const value = record[metric];
      if (isValidMetricValue(value)) entry.sums[metric] = (entry.sums[metric] ?? 0) + value;
    }
    buckets.set(bucket.key, entry);
  }

  // Periods with no source-reported value for ANY of the four metrics carry
  // no information - dropped. Oldest -> newest, bounded to the most recent.
  const ordered = [...buckets.values()]
    .filter((bucket) => PLATFORM_VIEW_METRICS.some((metric) => bucket.sums[metric] !== undefined))
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(-maxPeriods);

  const series: PlatformTrendSeries[] = [];
  const omittedMetrics: PlatformViewMetricId[] = [];
  for (const metric of PLATFORM_VIEW_METRICS) {
    const values = ordered.map((bucket) => bucket.sums[metric] ?? null);
    const realPoints = values.filter((value) => value !== null).length;
    if (realPoints >= 2) series.push({ metric, label: PLATFORM_VIEW_METRIC_LABELS[metric], values });
    else if (realPoints === 1) omittedMetrics.push(metric); // reported once - not enough for a trend.
    // realPoints === 0: never reported at all - nothing to disclose here; the KPI row already says Unavailable.
  }

  if (series.length === 0) return { periods: [], series: [], omittedMetrics };

  // Drop periods where none of the PLOTTED series has a value.
  const keep = ordered.map((_, index) => series.some((s) => s.values[index] !== null));
  const periods = ordered.filter((_, index) => keep[index]).map((bucket) => ({ key: bucket.key, label: bucket.label }));
  return { periods, series: series.map((s) => ({ ...s, values: s.values.filter((_, index) => keep[index]) })), omittedMetrics };
}

// ---- Published Content selection -------------------------------------------------

export const PUBLISHED_CONTENT_ROW_LIMIT = 10;

function postTimeMs(record: Pick<AnalyticsContentSourceRecordDoc, "postDateTimeIso">): number | null {
  if (!record.postDateTimeIso) return null;
  const ms = Date.parse(record.postDateTimeIso);
  return Number.isNaN(ms) ? null : ms;
}

// Newest first by the record's REAL posted date (null / unparseable dates
// last), then most recently imported, then sourceRef - a total, stable order.
export function comparePublishedContentNewestFirst(a: AnalyticsContentSourceRecordDoc, b: AnalyticsContentSourceRecordDoc): number {
  const aMs = postTimeMs(a);
  const bMs = postTimeMs(b);
  if (aMs !== bMs) {
    if (aMs === null) return 1;
    if (bMs === null) return -1;
    return bMs - aMs;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.sourceRef < b.sourceRef ? -1 : a.sourceRef > b.sourceRef ? 1 : 0;
}

export function selectPublishedContentRecords(contentRecords: AnalyticsContentSourceRecordDoc[], platform: PlatformViewId, limit = PUBLISHED_CONTENT_ROW_LIMIT): { records: AnalyticsContentSourceRecordDoc[]; total: number } {
  const records = forPlatform(contentRecords, platform);
  return { records: [...records].sort(comparePublishedContentNewestFirst).slice(0, limit), total: records.length };
}

// ---- Partner Account snapshots ----------------------------------------------------

export const PARTNER_ACCOUNT_ROW_LIMIT = 25;

export type PartnerAccountSnapshotSelection = {
  partnerAccountRef: string;
  // The account's ONE chosen snapshot record (see selectLatestAccountSnapshots).
  snapshot: AnalyticsChannelSourceRecordDoc;
  // How many MATCHED channel records exist for this account in the window -
  // disclosed, never combined into any total.
  snapshotCount: number;
};

function snapshotRecency(record: AnalyticsChannelSourceRecordDoc): [string, string, string] {
  return [record.reportingPeriod?.end ?? "", record.createdAt, record.sourceRef];
}

// Later snapshot first: newest reporting-period end, then newest import time,
// then sourceRef (a period-bearing snapshot outranks a period-less one).
function compareSnapshotNewestFirst(a: AnalyticsChannelSourceRecordDoc, b: AnalyticsChannelSourceRecordDoc): number {
  const [aEnd, aCreated, aRef] = snapshotRecency(a);
  const [bEnd, bCreated, bRef] = snapshotRecency(b);
  if (aEnd !== bEnd) return aEnd < bEnd ? 1 : -1;
  if (aCreated !== bCreated) return aCreated < bCreated ? 1 : -1;
  return aRef < bRef ? -1 : aRef > bRef ? 1 : 0;
}

// One row per MATCHED Partner Account: the account's latest snapshot that
// actually carries a verified profileFollowers value (falling back to its
// latest record - value `null` - when none does, so the account is still
// listed as Unavailable rather than silently dropped). A snapshot is ONE
// point in time for ONE account: nothing here sums, averages or diffs
// snapshots, and no cross-account total is produced. UNMATCHED/AMBIGUOUS
// channel records have no Partner Account and are counted in Source
// Quality instead. Result order: freshest chosen snapshot first, then
// accountRef.
export function selectLatestAccountSnapshots(channelRecords: AnalyticsChannelSourceRecordDoc[], platform: PlatformViewId): PartnerAccountSnapshotSelection[] {
  const byAccount = new Map<string, AnalyticsChannelSourceRecordDoc[]>();
  for (const record of forPlatform(channelRecords, platform)) {
    if (record.matchState !== "MATCHED" || !record.matchedPartnerAccountRef) continue;
    const list = byAccount.get(record.matchedPartnerAccountRef) ?? [];
    list.push(record);
    byAccount.set(record.matchedPartnerAccountRef, list);
  }

  const selections: PartnerAccountSnapshotSelection[] = [];
  for (const [partnerAccountRef, records] of byAccount) {
    const sorted = [...records].sort(compareSnapshotNewestFirst);
    const snapshot = sorted.find((record) => isValidMetricValue(record.profileFollowers)) ?? sorted[0]!;
    selections.push({ partnerAccountRef, snapshot, snapshotCount: records.length });
  }

  return selections.sort((a, b) => {
    const byRecency = compareSnapshotNewestFirst(a.snapshot, b.snapshot);
    return byRecency !== 0 ? byRecency : a.partnerAccountRef < b.partnerAccountRef ? -1 : a.partnerAccountRef > b.partnerAccountRef ? 1 : 0;
  });
}

// ---- Source Quality -------------------------------------------------------------------

export type LinkageCounts = { total: number; linked: number; unlinked: number; ambiguous: number };

export type MissingMetricEntry = {
  kind: "content" | "channel";
  metric: PlatformViewMetricId | "profileFollowers";
  label: string;
  missing: number;
  total: number;
};

export type PlatformSourceQuality = {
  content: LinkageCounts;
  channel: LinkageCounts;
  missingMetrics: MissingMetricEntry[];
  freshness: { latestContentAt: string | null; latestChannelAt: string | null; latestAt: string | null };
};

function linkageCounts(records: Array<{ matchState: string }>): LinkageCounts {
  const exceptions = aggregateIngestionExceptionCounts(records);
  return { total: records.length, linked: records.filter((r) => r.matchState === "MATCHED").length, unlinked: exceptions.unmatched, ambiguous: exceptions.ambiguous };
}

export function buildPlatformSourceQuality(contentRecords: AnalyticsContentSourceRecordDoc[], channelRecords: AnalyticsChannelSourceRecordDoc[], platform: PlatformViewId): PlatformSourceQuality {
  const content = forPlatform(contentRecords, platform);
  const channel = forPlatform(channelRecords, platform);

  const missingMetrics: MissingMetricEntry[] = [
    ...PLATFORM_VIEW_METRICS.map((metric): MissingMetricEntry => ({ kind: "content", metric, label: PLATFORM_VIEW_METRIC_LABELS[metric], missing: content.filter((r) => !isValidMetricValue(r[metric])).length, total: content.length })),
    { kind: "channel", metric: "profileFollowers", label: "Profile followers", missing: channel.filter((r) => !isValidMetricValue(r.profileFollowers)).length, total: channel.length },
  ];

  const latestContentAt = aggregateFreshnessByPlatform(content.map((r) => ({ platform, createdAt: r.createdAt })))[platform] ?? null;
  const latestChannelAt = aggregateFreshnessByPlatform(channel.map((r) => ({ platform, createdAt: r.createdAt })))[platform] ?? null;
  const latestAt = latestContentAt && latestChannelAt ? (latestContentAt > latestChannelAt ? latestContentAt : latestChannelAt) : (latestContentAt ?? latestChannelAt);

  return { content: linkageCounts(content), channel: linkageCounts(channel), missingMetrics, freshness: { latestContentAt, latestChannelAt, latestAt } };
}
