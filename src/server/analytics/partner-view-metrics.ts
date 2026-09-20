// Step 12E: the pure composition math behind the Partner-wise Analytics
// drill-down (partner-view-service.ts is the async orchestration; nothing
// here touches Firestore or an ActorContext, so every branch is directly
// Vitest-testable with synthetic input).
//
// It BUILDS ON the accepted 12D helpers (platform-view-metrics.ts) rather than
// forking their aggregation: every per-platform number is produced by the same
// aggregatePlatformKpis / buildPlatformTrend / selectLatestAccountSnapshots /
// buildPlatformSourceQuality the Instagram / YouTube pages use, run once per
// INCLUDED platform. This file only decides how those per-platform results are
// laid side by side (and, where a shared unit genuinely exists, combined).
//
// Semantics carried over unchanged from the accepted Overview / 12D:
//   - missing != zero: a metric never once source-reported stays `null`;
//   - Engagement is the source-reported `engagement` field ONLY (never
//     likes + comments);
//   - Views are a platform-NATIVE count. The accepted Overview never sums
//     Views across platforms, so neither does this page: on `All` the Views
//     KPI has NO combined total (per-platform values only);
//   - Published content, Engagement, Likes and Comments share a unit across
//     platforms (source records / source-reported counts) and MAY total across
//     platforms, always with honest coverage and a per-platform split;
//   - no Reach / Shares / Saves / Watch Time / Impressions / subscriber growth
//     key exists anywhere in these shapes, and nothing here scores, weights or
//     blends anything;
//   - profile followers are point-in-time SNAPSHOTS per Partner Account: never
//     summed (no total field exists), never presented as growth.
//
// Agreement / target context is DELIBERATELY absent: there is no accepted safe
// read path for Agreement targets at this baseline (the Partner Reviews
// commercial-policy seam is an internal module whose default provider is
// "none"), and Analytics must not depend on or duplicate commercial-policy
// logic. Nothing in the Partner Analytics files imports Partner Reviews or
// Finance (asserted by partner-view-static.test.ts).
import { formatCompact, type KpiDatum } from "@/features/shared/types";

import {
  aggregatePlatformKpis,
  buildPlatformSourceQuality,
  buildPlatformTrend,
  comparePublishedContentNewestFirst,
  forPlatform,
  isValidMetricValue,
  PLATFORM_VIEW_COPY,
  PLATFORM_VIEW_IDS,
  PLATFORM_VIEW_METRIC_LABELS,
  parsePlatformViewId,
  selectLatestAccountSnapshots,
  type LinkageCounts,
  type MissingMetricEntry,
  type PlatformTrend,
  type PlatformViewId,
  type PlatformViewMetricId,
} from "./platform-view-metrics";
import type { AnalyticsChannelSourceRecordDoc, AnalyticsContentSourceRecordDoc } from "./types";

// ---- Platform selection ------------------------------------------------------------

// The local view filter: `All` or ONE platform. Never a global navigation state.
export type PartnerViewSelection = "all" | PlatformViewId;
export const PARTNER_VIEW_SELECTIONS: readonly PartnerViewSelection[] = ["all", ...PLATFORM_VIEW_IDS];

// Parses the raw ?platform= query value. Normalized with the ONE shared
// platform-identifier contract (via parsePlatformViewId: trim + lowercase) and
// accepted ONLY if it is instagram|youtube. Anything else - garbage, `all`,
// empty, a repeated param (Next hands `string[]`), a non-string - is `All`.
// It never throws and never yields an arbitrary platform.
export function parsePartnerViewSelection(input: unknown): PartnerViewSelection {
  if (typeof input !== "string") return "all";
  return parsePlatformViewId(input) ?? "all";
}

export function platformsForSelection(selection: PartnerViewSelection): PlatformViewId[] {
  return selection === "all" ? [...PLATFORM_VIEW_IDS] : [selection];
}

export function platformLabelOf(platform: PlatformViewId): string {
  return PLATFORM_VIEW_COPY[platform].label;
}

export function selectionLabel(selection: PartnerViewSelection): string {
  return selection === "all" ? "All platforms" : platformLabelOf(selection);
}

// ---- Reporting period ---------------------------------------------------------------

export type PartnerReportingPeriod = {
  // Ready-to-render text. There is NO period filter: the label describes what
  // the included records represent, never a control that was applied.
  label: string;
  start: string | null;
  end: string | null;
  recordsWithoutPeriod: number;
  recordsTotal: number;
};

export const ALL_AVAILABLE_PERIODS_LABEL = "All available imported periods";

export function derivePartnerReportingPeriod(records: { reportingPeriod: { start: string; end: string } | null }[]): PartnerReportingPeriod {
  const recordsTotal = records.length;
  if (recordsTotal === 0) return { label: "No source data yet", start: null, end: null, recordsWithoutPeriod: 0, recordsTotal: 0 };

  let start: string | null = null;
  let end: string | null = null;
  let withPeriod = 0;
  for (const record of records) {
    if (!record.reportingPeriod) continue;
    withPeriod++;
    if (start === null || record.reportingPeriod.start < start) start = record.reportingPeriod.start;
    if (end === null || record.reportingPeriod.end > end) end = record.reportingPeriod.end;
  }
  const recordsWithoutPeriod = recordsTotal - withPeriod;
  const noPeriod = recordsWithoutPeriod > 0 ? `No reporting period on ${recordsWithoutPeriod} record${recordsWithoutPeriod === 1 ? "" : "s"}` : null;

  const label = start !== null && end !== null ? [`${ALL_AVAILABLE_PERIODS_LABEL}: ${start} – ${end}`, noPeriod].filter(Boolean).join(" · ") : `${ALL_AVAILABLE_PERIODS_LABEL} · ${noPeriod}`;
  return { label, start, end, recordsWithoutPeriod, recordsTotal };
}

// ---- KPI aggregates -------------------------------------------------------------------

export type PartnerPlatformCount = { platform: PlatformViewId; count: number };

export type PartnerMetricByPlatform = {
  platform: PlatformViewId;
  // This platform's own source-reported total; `null` (never 0) when not one
  // of its records reported the metric.
  total: number | null;
  recordsWithValue: number;
  recordsTotal: number;
};

export type PartnerMetricKpi = {
  // `null` when nothing was reported OR when combining is not allowed
  // (`totalBasis: "not_combined"` - Views on `All`).
  total: number | null;
  totalBasis: "single_platform" | "sum_across_platforms" | "not_combined";
  // Summed across the included platforms: record counts share one unit.
  recordsWithValue: number;
  recordsTotal: number;
  byPlatform: PartnerMetricByPlatform[];
};

export type PartnerKpis = {
  publishedContent: { total: number; byPlatform: PartnerPlatformCount[] };
  views: PartnerMetricKpi;
  engagement: PartnerMetricKpi;
  likes: PartnerMetricKpi;
  comments: PartnerMetricKpi;
};

export function aggregatePartnerKpis(contentRecords: AnalyticsContentSourceRecordDoc[], selection: PartnerViewSelection): PartnerKpis {
  const platforms = platformsForSelection(selection);
  const perPlatform = platforms.map((platform) => ({ platform, kpis: aggregatePlatformKpis(contentRecords, platform) }));

  const metric = (id: PlatformViewMetricId): PartnerMetricKpi => {
    const byPlatform = perPlatform.map(({ platform, kpis }): PartnerMetricByPlatform => ({ platform, total: kpis[id].total, recordsWithValue: kpis[id].recordsWithValue, recordsTotal: kpis[id].recordsTotal }));
    const reported = byPlatform.filter((entry): entry is PartnerMetricByPlatform & { total: number } => entry.total !== null);
    const combined = reported.length > 0 ? reported.reduce((acc, entry) => acc + entry.total, 0) : null;
    // Views are native per-platform counts: never combined on `All`.
    const notCombined = id === "views" && selection === "all";
    return {
      total: notCombined ? null : combined,
      totalBasis: notCombined ? "not_combined" : selection === "all" ? "sum_across_platforms" : "single_platform",
      recordsWithValue: byPlatform.reduce((acc, entry) => acc + entry.recordsWithValue, 0),
      recordsTotal: byPlatform.reduce((acc, entry) => acc + entry.recordsTotal, 0),
      byPlatform,
    };
  };

  const byPlatformCounts = perPlatform.map(({ platform, kpis }): PartnerPlatformCount => ({ platform, count: kpis.publishedContent }));
  return {
    publishedContent: { total: byPlatformCounts.reduce((acc, entry) => acc + entry.count, 0), byPlatform: byPlatformCounts },
    views: metric("views"),
    engagement: metric("engagement"),
    likes: metric("likes"),
    comments: metric("comments"),
  };
}

function metricSplitText(byPlatform: PartnerMetricByPlatform[]): string {
  return byPlatform.map((entry) => `${platformLabelOf(entry.platform)} ${entry.total === null ? "Unavailable" : formatCompact(entry.total)}`).join(" · ");
}

function countSplitText(byPlatform: PartnerPlatformCount[]): string {
  return byPlatform.map((entry) => `${platformLabelOf(entry.platform)} ${entry.count === 0 ? "Unavailable" : entry.count}`).join(" · ");
}

// The frozen 5-slot KPI row: Published content, Views, Engagement, Likes,
// Comments - Partner-scoped over the selected platform selection. Every slot
// carries the per-platform split in its hint; no Reach slot, no derived slot.
export function buildPartnerKpiData(kpis: PartnerKpis): KpiDatum[] {
  const published: KpiDatum =
    kpis.publishedContent.total === 0
      ? { icon: "file", label: "Published content", value: "Unavailable", hint: `No source content records yet · ${countSplitText(kpis.publishedContent.byPlatform)}` }
      : { icon: "file", label: "Published content", value: formatCompact(kpis.publishedContent.total), hint: `${kpis.publishedContent.total} source content record${kpis.publishedContent.total === 1 ? "" : "s"} · ${countSplitText(kpis.publishedContent.byPlatform)}` };

  const card = (id: PlatformViewMetricId, icon: KpiDatum["icon"]): KpiDatum => {
    const kpi = kpis[id];
    const label = PLATFORM_VIEW_METRIC_LABELS[id];
    const split = metricSplitText(kpi.byPlatform);
    const reportedAnywhere = kpi.byPlatform.some((entry) => entry.total !== null);
    if (!reportedAnywhere) return { icon, label, value: "Unavailable", hint: `No source-reported ${label} yet · ${split}` };
    if (kpi.totalBasis === "not_combined") return { icon, label, value: "By platform", hint: `${split} · native counts, not combined` };
    const coverage = kpi.recordsWithValue === kpi.recordsTotal ? `all ${kpi.recordsTotal}` : `${kpi.recordsWithValue} of ${kpi.recordsTotal}`;
    return { icon, label, value: formatCompact(kpi.total as number), hint: `source-reported · ${coverage} record${kpi.recordsTotal === 1 ? "" : "s"} · ${split}` };
  };

  return [published, card("views", "chart"), card("engagement", "flag"), card("likes", "check"), card("comments", "mail")];
}

// ---- Platform Performance (separate series per platform) -----------------------------

export type PartnerPlatformCard = {
  platform: PlatformViewId;
  label: string;
  // false = not one source record on this platform: rendered as an explicit
  // "Unavailable - no source data" card, never hidden.
  hasData: boolean;
  recordCount: number;
  trend: PlatformTrend;
};

// One card per INCLUDED platform, always (a platform with no data is still a
// card). Each card's trend is that platform's OWN buildPlatformTrend - series
// are never merged across platforms.
export function buildPartnerPlatformCards(contentRecords: AnalyticsContentSourceRecordDoc[], selection: PartnerViewSelection): PartnerPlatformCard[] {
  return platformsForSelection(selection).map((platform) => {
    const records = forPlatform(contentRecords, platform);
    return { platform, label: platformLabelOf(platform), hasData: records.length > 0, recordCount: records.length, trend: buildPlatformTrend(contentRecords, platform) };
  });
}

// ---- Top Content ------------------------------------------------------------------------

export const TOP_CONTENT_LIMIT = 5; // per platform list

export type TopContentBasis = "views" | "engagement" | "none";

export type TopContentGroup = { platform: PlatformViewId; records: AnalyticsContentSourceRecordDoc[] };
export type TopContentSelection = { basis: TopContentBasis; groups: TopContentGroup[] };

// ONE explicit ranking basis for the whole panel, never blended:
//   - Views when at least one included record has a valid Views value;
//   - otherwise Engagement (only) when at least one has a valid Engagement;
//   - otherwise nothing is ranked.
// Records are ranked only among those that HAVE the basis metric, descending,
// with a deterministic tie-break (newest posted / imported, then stable
// sourceRef). Because Views are native per-platform counts, ranking is done
// WITHIN each platform - there is no cross-platform ordering and no
// normalization. A platform with no record carrying the basis metric has an
// empty group (the panel says so); the basis is never silently switched.
export function selectTopContent(contentRecords: AnalyticsContentSourceRecordDoc[], selection: PartnerViewSelection, limit = TOP_CONTENT_LIMIT): TopContentSelection {
  const platforms = platformsForSelection(selection);
  const included = platforms.flatMap((platform) => forPlatform(contentRecords, platform));
  const basis: TopContentBasis = included.some((r) => isValidMetricValue(r.views)) ? "views" : included.some((r) => isValidMetricValue(r.engagement)) ? "engagement" : "none";
  if (basis === "none") return { basis, groups: [] };

  const groups = platforms.map((platform): TopContentGroup => {
    const ranked = forPlatform(contentRecords, platform)
      .filter((record) => isValidMetricValue(record[basis]))
      .sort((a, b) => {
        const byMetric = (b[basis] as number) - (a[basis] as number);
        return byMetric !== 0 ? byMetric : comparePublishedContentNewestFirst(a, b);
      });
    return { platform, records: ranked.slice(0, limit) };
  });
  return { basis, groups };
}

export function topContentNote(basis: TopContentBasis, selection: PartnerViewSelection): string {
  const within = selection === "all" ? `, within each platform (native counts are never compared across platforms; top ${TOP_CONTENT_LIMIT} per platform)` : ` (top ${TOP_CONTENT_LIMIT})`;
  if (basis === "views") return `Ranked by Views${within}`;
  if (basis === "engagement") return `Ranked by Engagement (no Views reported)${within}`;
  return "No content with reported Views or Engagement";
}

// ---- Partner Accounts ---------------------------------------------------------------------

export const PARTNER_ACCOUNT_ROW_LIMIT = 25;

export type PartnerAccountSelection = {
  partnerAccountRef: string;
  platform: PlatformViewId;
  // The account's ONE chosen verified snapshot record (null = no channel
  // snapshot in the window - the account is linked only through content).
  snapshot: AnalyticsChannelSourceRecordDoc | null;
  snapshotCount: number;
  contentRecords: number;
  channelRecords: number;
};

// One row per canonical Partner Account (identity = matchedPartnerAccountRef,
// never a display name), across the included platforms: the union of accounts
// reached through matched channel snapshots and matched content records. An
// account keeps its OWN latest snapshot (selectLatestAccountSnapshots); nothing
// here sums, averages or diffs snapshots and no cross-account total exists.
export function selectPartnerAccounts(contentRecords: AnalyticsContentSourceRecordDoc[], channelRecords: AnalyticsChannelSourceRecordDoc[], selection: PartnerViewSelection): PartnerAccountSelection[] {
  const rows: PartnerAccountSelection[] = [];
  for (const platform of platformsForSelection(selection)) {
    const byRef = new Map<string, PartnerAccountSelection>();
    for (const { partnerAccountRef, snapshot, snapshotCount } of selectLatestAccountSnapshots(channelRecords, platform)) {
      byRef.set(partnerAccountRef, { partnerAccountRef, platform, snapshot, snapshotCount, contentRecords: 0, channelRecords: snapshotCount });
    }
    for (const record of forPlatform(contentRecords, platform)) {
      if (record.matchState !== "MATCHED" || !record.matchedPartnerAccountRef) continue;
      const existing = byRef.get(record.matchedPartnerAccountRef) ?? { partnerAccountRef: record.matchedPartnerAccountRef, platform, snapshot: null, snapshotCount: 0, contentRecords: 0, channelRecords: 0 };
      existing.contentRecords++;
      byRef.set(record.matchedPartnerAccountRef, existing);
    }
    // Freshest snapshot first; accounts with no snapshot last; stable by ref.
    rows.push(
      ...[...byRef.values()].sort((a, b) => {
        const aAt = a.snapshot?.createdAt ?? "";
        const bAt = b.snapshot?.createdAt ?? "";
        if (aAt !== bAt) return aAt < bAt ? 1 : -1;
        return a.partnerAccountRef < b.partnerAccountRef ? -1 : a.partnerAccountRef > b.partnerAccountRef ? 1 : 0;
      }),
    );
  }
  return rows;
}

// ---- Data Quality / Freshness ---------------------------------------------------------------

export type PartnerLinkageCounts = LinkageCounts & {
  // Records matched to this Partner but NOT to one of its Partner Accounts.
  withoutAccount: number;
};

export type PartnerSourceQuality = {
  content: PartnerLinkageCounts;
  channel: PartnerLinkageCounts;
  missingMetrics: MissingMetricEntry[];
  freshness: { latestContentAt: string | null; latestChannelAt: string | null; latestAt: string | null };
  accountCoverage: {
    accountsTotal: number;
    // Accounts whose chosen snapshot carries a verified profileFollowers value.
    accountsWithSnapshots: number;
    // Content + channel records with no Partner Account link.
    recordsWithoutAccount: number;
  };
};

function latest(a: string | null, b: string | null): string | null {
  return a && b ? (a > b ? a : b) : (a ?? b);
}

// Per-platform 12D source quality (buildPlatformSourceQuality), merged across
// the included platforms: record counts and missing-metric counts share one
// unit and add; freshness is the most recent. Absence of records is "No source
// data yet" (total 0), never zero performance.
export function buildPartnerSourceQuality(
  contentRecords: AnalyticsContentSourceRecordDoc[],
  channelRecords: AnalyticsChannelSourceRecordDoc[],
  selection: PartnerViewSelection,
  accounts: PartnerAccountSelection[],
): PartnerSourceQuality {
  const platforms = platformsForSelection(selection);
  const qualities = platforms.map((platform) => buildPlatformSourceQuality(contentRecords, channelRecords, platform));

  const addLinkage = (pick: (q: (typeof qualities)[number]) => LinkageCounts): LinkageCounts =>
    qualities.reduce<LinkageCounts>((acc, q) => ({ total: acc.total + pick(q).total, linked: acc.linked + pick(q).linked, unlinked: acc.unlinked + pick(q).unlinked, ambiguous: acc.ambiguous + pick(q).ambiguous }), { total: 0, linked: 0, unlinked: 0, ambiguous: 0 });

  const includedContent = platforms.flatMap((platform) => forPlatform(contentRecords, platform));
  const includedChannel = platforms.flatMap((platform) => forPlatform(channelRecords, platform));
  const contentWithoutAccount = includedContent.filter((r) => !r.matchedPartnerAccountRef).length;
  const channelWithoutAccount = includedChannel.filter((r) => !r.matchedPartnerAccountRef).length;

  const missingByKey = new Map<string, MissingMetricEntry>();
  for (const quality of qualities) {
    for (const entry of quality.missingMetrics) {
      const key = `${entry.kind}:${entry.metric}`;
      const existing = missingByKey.get(key);
      missingByKey.set(key, existing ? { ...existing, missing: existing.missing + entry.missing, total: existing.total + entry.total } : { ...entry });
    }
  }

  const latestContentAt = qualities.reduce<string | null>((acc, q) => latest(acc, q.freshness.latestContentAt), null);
  const latestChannelAt = qualities.reduce<string | null>((acc, q) => latest(acc, q.freshness.latestChannelAt), null);

  return {
    content: { ...addLinkage((q) => q.content), withoutAccount: contentWithoutAccount },
    channel: { ...addLinkage((q) => q.channel), withoutAccount: channelWithoutAccount },
    missingMetrics: [...missingByKey.values()],
    freshness: { latestContentAt, latestChannelAt, latestAt: latest(latestContentAt, latestChannelAt) },
    accountCoverage: {
      accountsTotal: accounts.length,
      accountsWithSnapshots: accounts.filter((a) => a.snapshot !== null && isValidMetricValue(a.snapshot.profileFollowers)).length,
      recordsWithoutAccount: contentWithoutAccount + channelWithoutAccount,
    },
  };
}
