import { formatCompact } from "@/features/shared/types";

import type { ReportDefinition, ReportResult, ReportRow } from "../../types";
import { buildDistribution, VIEW_BAND_SET_V1 } from "../bands";
import { buildDataQualitySection } from "../data-quality";
import { buildCoverSection, titleCaseFromCamel } from "../helpers";
import { buildSourceMetricLeadersTable, type LeaderCandidate } from "../leaders";
import type { ReportKpiItem, ReportSectionModel, ReportTableSection, TableColumn, TableRow } from "../types";

// Reports Final-Master (spec section 5A), revised by Reports PDF Composition & Management-Publication
// Polish: FULL bespoke treatment for Monthly Partner Performance - the flagship template. Composes the
// required sections entirely from the EXISTING monthly-partner-performance.ts family result (no new
// source reads, no new Firestore queries) - a pure reporting/presentation layer over already-governed
// evidence, per spec section 1's "do not rewrite working executors". This revision fixes: page
// orientation (now landscape - see report-templates.ts), human-facing performance-table columns (spec
// section 5), a per-Partner View-Band Distribution matrix (spec section 9), bounded multi-Partner Top
// Content (spec section 10), Source-Metric Leaders extended to Likes/Comments/Output (spec section 8),
// a safe-state Partner Account Directory (spec section 13), a management KPI hierarchy (spec section
// 11) and a real cover platforms/period line (spec section 3).
const PLATFORMS = ["instagram", "youtube"] as const;
type Platform = (typeof PLATFORMS)[number];

const PLATFORM_LABELS: Record<Platform, string> = { instagram: "Instagram", youtube: "YouTube" };

function platformRows(result: ReportResult, platform: string): ReportRow[] {
  return result.rows.filter((r) => r.platform === platform);
}

// Spec section 11: headline metrics vs. the secondary, compact Review-evidence coverage KPI group - see
// families/monthly-partner-performance.ts's own metrics-ordering comment for the producer side of this
// split.
const REVIEW_EVIDENCE_METRIC_IDS = new Set(["finalizedReviewCount", "withComplianceEvidenceCount", "withPerformanceEvidenceCount"]);
// Metric ids whose value gets abbreviated management-style formatting (spec section 11: "892K",
// "1.20M", "48.31M") on the headline KPI grid - large aggregate counts (Views/Engagement), never a small
// Partner/account count where abbreviation would be actively less readable.
const COMPACT_METRIC_ID_PATTERN = /^(views|engagement)_/;
// A friendlier label than the generic titleCaseFromCamel fallback would produce for a per-platform
// metric id (e.g. "accountCoverageCount_instagram" -> "Account Coverage Count instagram", with a
// stray lowercase platform name tacked on) - "Instagram Account Coverage" reads as real management
// copy. Falls back to titleCaseFromCamel for anything not in this explicit map (finalizedReviewCount
// and friends already read fine through that generic path).
const FRIENDLY_METRIC_LABELS: Record<string, string> = {
  accountCoverageCount_instagram: "Instagram Account Coverage",
  accountCoverageCount_youtube: "YouTube Account Coverage",
  publishedContentCount_instagram: "Instagram Published Content",
  publishedContentCount_youtube: "YouTube Published Content",
  views_instagram: "Instagram Views",
  views_youtube: "YouTube Views",
  engagement_instagram: "Instagram Engagement",
  engagement_youtube: "YouTube Engagement",
  staleAccountCount_instagram: "Instagram Stale Accounts",
  staleAccountCount_youtube: "YouTube Stale Accounts",
};

function kpiItemsFromMetrics(metrics: Record<string, number | string | null>, predicate: (id: string) => boolean): ReportKpiItem[] {
  return Object.entries(metrics)
    .filter(([id]) => predicate(id))
    .map(([id, value]) => {
      const label = FRIENDLY_METRIC_LABELS[id] ?? titleCaseFromCamel(id);
      if (value === null) return { label, value: "Not available", unavailable: true };
      if (typeof value === "number" && COMPACT_METRIC_ID_PATTERN.test(id)) return { label, value: formatCompact(value) };
      if (typeof value === "number") return { label, value: value.toLocaleString("en-IN") };
      return { label, value: String(value) };
    });
}

// ---- Platform performance table (spec section 5: human-facing fields only) ----------------------------

function platformHasAnyValue(rows: ReportRow[], field: string): boolean {
  return rows.some((r) => r[field] !== null && r[field] !== undefined);
}

function buildPlatformPerformanceTable(platform: Platform, rows: ReportRow[]): ReportTableSection {
  const label = PLATFORM_LABELS[platform];
  const hasFollowers = platformHasAnyValue(rows, "followersSnapshot");
  const hasLinks = platformHasAnyValue(rows, "openPartner");
  const columns: TableColumn[] = [
    { id: "partnerDisplayName", label: "Partner" },
    { id: "publishedContentCount", label: platform === "youtube" ? "Videos / Published Content" : "Posts / Published Content", numeric: true },
    { id: "contentWithMetricsCount", label: "Content with Metrics", numeric: true },
    ...(hasFollowers ? [{ id: "followersSnapshot", label: platform === "youtube" ? "Subscribers" : "Followers", numeric: true }] : []),
    { id: "views", label: "Views", numeric: true },
    { id: "likes", label: "Likes", numeric: true },
    { id: "comments", label: "Comments", numeric: true },
    { id: "engagement", label: "Engagement", numeric: true },
    ...(hasLinks ? [{ id: "openPartner", label: "Open Partner" }] : []),
  ];
  const sum = (id: string): number | null => rows.reduce<number | null>((acc, r) => (typeof r[id] === "number" ? (acc ?? 0) + (r[id] as number) : acc), null);
  const totalsRow: TableRow | undefined =
    rows.length > 0
      ? {
          partnerDisplayName: "Total",
          publishedContentCount: sum("publishedContentCount"),
          contentWithMetricsCount: sum("contentWithMetricsCount"),
          ...(hasFollowers ? { followersSnapshot: null } : {}),
          views: sum("views"),
          likes: sum("likes"),
          comments: sum("comments"),
          engagement: sum("engagement"),
          ...(hasLinks ? { openPartner: null } : {}),
        }
      : undefined;
  return {
    kind: "table",
    sectionType: "partner_performance_table",
    mode: "EVIDENCE",
    title: `${label} Partner Performance`,
    note: rows.length === 0 ? undefined : `${rows.length} Partner row(s) with a tracked ${label} account or matched content in this run.`,
    columns,
    rows: rows as TableRow[],
    totalsRow,
    emptyMessage: `No ${label} Partner Accounts or matched Content were found for this reporting period.`,
  };
}

// ---- View-Band Distribution: per-Partner Content counts by band (spec section 9) ------------------------

function buildViewBandMatrix(platform: Platform, rows: ReportRow[], viewsByPartner: Record<string, (number | null)[]>): ReportTableSection {
  const label = PLATFORM_LABELS[platform];
  const bandSet = VIEW_BAND_SET_V1;
  let omittedNullCount = 0;
  const matrixRows: TableRow[] = rows.map((row) => {
    const partnerRef = String(row.partnerRef ?? "");
    const values = viewsByPartner[partnerRef] ?? [];
    const dist = buildDistribution(values, bandSet.bandSetId);
    omittedNullCount += dist.omittedNullCount;
    const matrixRow: TableRow = { partnerDisplayName: row.partnerDisplayName };
    for (const band of dist.bands) matrixRow[band.label] = band.count;
    return matrixRow;
  });
  const columns: TableColumn[] = [{ id: "partnerDisplayName", label: "Partner" }, ...bandSet.bands.map((b) => ({ id: b.label, label: b.label, numeric: true }))];
  return {
    kind: "table",
    sectionType: "performance_band_distribution",
    mode: "EVIDENCE",
    title: `${label} View/Performance-Band Distribution`,
    // Spec section 16: no internal band-set version key ("views_standard v1") in the finalized PDF - a
    // calm, human note instead. Spec section 9: each cell is a per-Partner COUNT OF CONTENT ITEMS in
    // that band, never a Partner count grouped by an aggregate band.
    note: matrixRows.length === 0 ? undefined : `Each cell is the number of ${label} Content items published by that Partner in the given views band. Content without a reported Views value is excluded from the distribution (not counted in the 0-1K band).${omittedNullCount > 0 ? ` ${omittedNullCount} Content item(s) had no reported Views and are excluded.` : ""}`,
    columns,
    rows: matrixRows,
    emptyMessage: `No ${label} Content with reported Views was found for this reporting period.`,
  };
}

// ---- Multi-Partner Top Content (spec section 10) ---------------------------------------------------------

type TopContentMetric = "views" | "engagement" | "comments" | "likes";
const TOP_CONTENT_METRIC_LABELS: Record<TopContentMetric, string> = { views: "Views", engagement: "Engagement", comments: "Comments", likes: "Likes" };
const TOP_CONTENT_N = 5;

function rankTopContent(candidates: ReportRow[], metric: TopContentMetric, n: number): ReportRow[] {
  return candidates
    .filter((c): c is ReportRow & Record<TopContentMetric, number> => typeof c[metric] === "number")
    .sort((a, b) => (b[metric] as number) - (a[metric] as number))
    .slice(0, n);
}

function buildTopContentTable(platform: Platform, candidates: ReportRow[], metric: TopContentMetric): ReportTableSection {
  const label = PLATFORM_LABELS[platform];
  const metricLabel = TOP_CONTENT_METRIC_LABELS[metric];
  const ranked = rankTopContent(candidates, metric, TOP_CONTENT_N);
  const rows: TableRow[] = ranked.map((c, index) => ({
    rank: index + 1,
    partnerDisplayName: c.partnerDisplayName,
    date: typeof c.publishedAt === "string" ? c.publishedAt.slice(0, 10) : null,
    views: c.views,
    likes: c.likes,
    comments: c.comments,
    engagement: c.engagement,
    // Spec section 7's paired-column convention: `openPost`/`openPostHref` carry the human label + real
    // deep link; falls back to the Partner's own Analytics link when the item has no direct post URL
    // (never a fabricated URL, never the raw link printed as visible text).
    openPost: (c.openPost as string | null) ?? (c.openPartner as string | null) ?? null,
    openPostHref: (c.openPostHref as string | null) ?? (c.openPartnerHref as string | null) ?? null,
  }));
  return {
    kind: "table",
    sectionType: "top_n_content",
    mode: "EVIDENCE",
    title: `${label} - Top ${TOP_CONTENT_N} by ${metricLabel}`,
    columns: [
      { id: "rank", label: "Rank", numeric: true },
      { id: "partnerDisplayName", label: "Partner" },
      { id: "date", label: "Date" },
      { id: "views", label: "Views", numeric: true },
      { id: "likes", label: "Likes", numeric: true },
      { id: "comments", label: "Comments", numeric: true },
      { id: "engagement", label: "Engagement", numeric: true },
      { id: "openPost", label: "Content" },
    ],
    rows,
    // Spec section 10's own required wording, adapted per platform.
    emptyMessage: `No qualifying ${label} content was available for this reporting period.`,
  };
}

// ---- Partner Account Directory / Appendix (spec section 13) -------------------------------------------

function accountStateFor(row: ReportRow | undefined): string {
  if (!row) return "N/A";
  const accountCount = typeof row.accountCount === "number" ? row.accountCount : 0;
  const staleAccountCount = typeof row.staleAccountCount === "number" ? row.staleAccountCount : 0;
  if (accountCount === 0) return "N/A";
  if (staleAccountCount >= accountCount) return "Stale";
  return "Tracked";
}

export function buildMonthlyPartnerPerformanceSections(definition: ReportDefinition, result: ReportResult, templateTitle: string): ReportSectionModel[] {
  const sections: ReportSectionModel[] = [];
  const includedPlatforms = PLATFORMS.filter((p) => platformRows(result, p).length > 0);
  const platformsLine = includedPlatforms.length > 0 ? includedPlatforms.map((p) => PLATFORM_LABELS[p]).join(" + ") : undefined;

  // 1. Cover - spec section 3: a real, source-backed platforms line (omitted when no platform has any
  // evidence yet, never fabricated) alongside the human reporting-period line.
  sections.push(buildCoverSection({ definition, templateTitle, result, platformsLine }));

  // 3. Management KPI hierarchy (spec section 11): Partner count / coverage / output / views /
  // engagement first; Review-evidence coverage kept as its own smaller, secondary section rather than
  // mixed into the primary headline grid.
  sections.push({ kind: "kpi_summary", sectionType: "kpi_summary", mode: "EVIDENCE", title: "Partner Count, Coverage, Output, Views & Engagement", items: kpiItemsFromMetrics(result.metrics, (id) => !REVIEW_EVIDENCE_METRIC_IDS.has(id)) });
  const reviewEvidenceItems = kpiItemsFromMetrics(result.metrics, (id) => REVIEW_EVIDENCE_METRIC_IDS.has(id));
  if (reviewEvidenceItems.length > 0) {
    sections.push({ kind: "kpi_summary", sectionType: "kpi_summary", mode: "EVIDENCE", title: "Partner Review Evidence Coverage", items: reviewEvidenceItems });
  }

  // 4. Source-Metric Leaders (spec section 8): Views, Engagement, Likes, Comments and Output - separate
  // leaderboards, never a blended score.
  const leaderMetrics: { id: "views" | "engagement" | "likes" | "comments" | "publishedContentCount"; label: string }[] = [
    { id: "publishedContentCount", label: "Output (Published Content)" },
    { id: "views", label: "Views" },
    { id: "engagement", label: "Engagement" },
    { id: "likes", label: "Likes" },
    { id: "comments", label: "Comments" },
  ];
  for (const platform of PLATFORMS) {
    const rows = platformRows(result, platform);
    for (const { id, label } of leaderMetrics) {
      const candidates: LeaderCandidate[] = rows.map((r) => ({ label: String(r.partnerDisplayName ?? r.partnerRef), value: typeof r[id] === "number" ? (r[id] as number) : null }));
      if (!candidates.some((c) => c.value !== null)) continue; // spec section 8: omit a metric leaderboard entirely when unavailable for this platform, rather than an all-empty table.
      sections.push(buildSourceMetricLeadersTable({ metricLabel: label, metricId: id, platformOrContext: PLATFORM_LABELS[platform], candidates, limit: 10 }));
    }
  }

  // 5/8. Instagram / YouTube Partner performance - human-facing fields only (spec section 5).
  for (const platform of PLATFORMS) {
    sections.push(buildPlatformPerformanceTable(platform, platformRows(result, platform)));
  }

  // 6/9. Instagram / YouTube View/Performance-Band Distribution - per-Partner Content-item counts by
  // band (spec section 9), not a Partner count grouped by band.
  const viewsByPartnerPlatform = (result.sections.viewsByPartnerPlatform as Record<Platform, Record<string, (number | null)[]>> | undefined) ?? { instagram: {}, youtube: {} };
  for (const platform of PLATFORMS) {
    sections.push(buildViewBandMatrix(platform, platformRows(result, platform), viewsByPartnerPlatform[platform] ?? {}));
  }

  // 7/10. Instagram / YouTube Top Content - bounded, report-scoped, multi-Partner Top-N by Views,
  // Engagement and Comments (spec section 10) - genuinely works for a multi-Partner run now.
  const topContentCandidatesByPlatform = (result.sections.topContentCandidatesByPlatform as Record<Platform, ReportRow[]> | undefined) ?? { instagram: [], youtube: [] };
  for (const platform of PLATFORMS) {
    const candidates = topContentCandidatesByPlatform[platform] ?? [];
    for (const metric of ["views", "engagement", "comments"] as const) {
      sections.push(buildTopContentTable(platform, candidates, metric));
    }
  }

  // 11. Data Coverage & Quality (kept for XLSX/Evidence Preview/API - not drawn in the PDF body, spec
  // section 19).
  sections.push(
    buildDataQualitySection({
      generatedAt: result.generatedAt,
      evidenceCutoff: result.evidenceCutoff,
      truncated: result.truncated,
      rowCount: result.rowCount,
      maxRows: result.maxRows,
      limitations: result.limitations,
      provenance: result.provenance,
    }),
  );

  // 12. Partner Account Directory / Appendix - spec section 13: safe coverage states, no Partner Ref, no
  // internal Analytics ref. Uses the FULL Partner roster (not just Partners with at least one tracked
  // row) so a Partner with no coverage on either platform still appears, honestly marked N/A.
  const roster = (result.sections.partnerRoster as { partnerRef: string; partnerDisplayName: string }[] | undefined) ?? [];
  const rowByPlatformAndPartner = new Map<string, ReportRow>();
  for (const row of result.rows) rowByPlatformAndPartner.set(`${row.platform}:${row.partnerRef}`, row);
  const directoryRows: TableRow[] = roster.map((p) => ({
    partnerDisplayName: p.partnerDisplayName,
    instagram: accountStateFor(rowByPlatformAndPartner.get(`instagram:${p.partnerRef}`)),
    youtube: accountStateFor(rowByPlatformAndPartner.get(`youtube:${p.partnerRef}`)),
  }));
  sections.push({
    kind: "table",
    sectionType: "account_directory",
    mode: "EVIDENCE",
    title: "Partner Account Directory / Appendix",
    // "YouTube" (proper brand casing) is spelled out explicitly here rather than relying on
    // buildGenericTable's generic titleCaseFromCamel(id) column-label derivation, which would produce
    // "Youtube" from the row's own `youtube` field id.
    columns: [
      { id: "partnerDisplayName", label: "Partner" },
      { id: "instagram", label: "Instagram" },
      { id: "youtube", label: "YouTube" },
    ],
    rows: directoryRows,
    note: "Tracked = a live Account is linked and fresh. Stale = linked but its last snapshot is older than the accepted freshness window. N/A = no Account is currently linked for this Partner on this platform.",
    emptyMessage: "No Partners in this run.",
  });

  return sections;
}
