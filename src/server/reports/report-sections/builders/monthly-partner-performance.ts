import type { ReportDefinition, ReportResult, ReportRow } from "../../types";
import { buildDistribution } from "../bands";
import { buildDataQualitySection } from "../data-quality";
import { buildCoverSection, buildGenericTable, buildKpiSummaryFromMetrics, titleCaseFromCamel } from "../helpers";
import { buildSourceMetricLeadersTable, type LeaderCandidate } from "../leaders";
import type { ReportSectionModel } from "../types";

// Reports Final-Master (spec section 5A): FULL bespoke treatment for Monthly Partner Performance -
// the flagship template. Composes the 13 required sections entirely from the EXISTING
// monthly-partner-performance.ts family result (no new source reads, no new Firestore queries) - a
// pure reporting/presentation layer over already-governed evidence, per spec section 1's "do not
// rewrite working executors".
const PLATFORMS = ["instagram", "youtube"] as const;

function platformRows(result: ReportResult, platform: string): ReportRow[] {
  return result.rows.filter((r) => r.platform === platform);
}

export function buildMonthlyPartnerPerformanceSections(definition: ReportDefinition, result: ReportResult, templateTitle: string): ReportSectionModel[] {
  const sections: ReportSectionModel[] = [];

  // 1. Cover.
  sections.push(buildCoverSection({ definition, templateTitle, result }));

  // 3. Platform coverage / output / views / engagement.
  sections.push(buildKpiSummaryFromMetrics("Platform Coverage, Output, Views & Engagement", result.metrics));

  // 4. Source-Metric Leaders (Views, separately Engagement) per platform - never a blended score.
  for (const platform of PLATFORMS) {
    const rows = platformRows(result, platform);
    const viewsCandidates: LeaderCandidate[] = rows.map((r) => ({ label: String(r.partnerDisplayName ?? r.partnerRef), value: typeof r.views === "number" ? r.views : null }));
    const engagementCandidates: LeaderCandidate[] = rows.map((r) => ({ label: String(r.partnerDisplayName ?? r.partnerRef), value: typeof r.engagement === "number" ? r.engagement : null }));
    sections.push(buildSourceMetricLeadersTable({ metricLabel: "Views", metricId: "views", platformOrContext: platform, candidates: viewsCandidates, limit: 10 }));
    sections.push(buildSourceMetricLeadersTable({ metricLabel: "Engagement", metricId: "engagement", platformOrContext: platform, candidates: engagementCandidates, limit: 10 }));
  }

  // 5/8. Instagram / YouTube Partner performance.
  for (const platform of PLATFORMS) {
    const rows = platformRows(result, platform);
    sections.push(
      buildGenericTable(`${titleCaseFromCamel(platform)} Partner Performance`, rows, {
        sectionType: "partner_performance_table",
        note: rows.length === 0 ? undefined : `${rows.length} Partner row(s) with a tracked ${titleCaseFromCamel(platform)} account or matched content in this run.`,
      }),
    );
  }

  // 6/9. Instagram / YouTube View/Performance-Band Distribution.
  for (const platform of PLATFORMS) {
    const rows = platformRows(result, platform);
    const dist = buildDistribution(rows.map((r) => (typeof r.views === "number" ? r.views : null)));
    sections.push({
      kind: "table",
      sectionType: "performance_band_distribution",
      mode: "EVIDENCE",
      title: `${titleCaseFromCamel(platform)} View/Performance-Band Distribution`,
      note: `Band set: ${dist.bandSetId} v${dist.bandSetVersion}. ${dist.omittedNullCount} Partner(s) omitted (no reported Views - never counted as the 0-1K band).`,
      columns: [
        { id: "label", label: "Band" },
        { id: "count", label: "Partner count", numeric: true },
      ],
      rows: dist.bands.map((b) => ({ label: b.label, count: b.count })),
    });
  }

  // 7/10. Instagram / YouTube Top Content. This family's own topContent (sections.topContent) is
  // computed ONLY for a single-Partner run (see the family's own extraLimitations) and carries no
  // per-platform metric value - so it is shown as a plain recent-Content table, never mislabeled as a
  // metric-ranked Top-N.
  const topContent = (result.sections.topContent as ReportRow[] | undefined) ?? [];
  for (const platform of PLATFORMS) {
    if (topContent.length === 0) {
      sections.push({
        kind: "table",
        sectionType: "top_n_content",
        mode: "EVIDENCE",
        title: `${titleCaseFromCamel(platform)} Top Content`,
        unavailableReason: "Top Content is only computed when a single Partner is selected via the partnerRef filter (a bounded, single-Partner Content query) - unavailable for a multi-Partner run.",
        columns: [{ id: "contentRef", label: "Content" }],
        rows: [],
        emptyMessage: "Not available for this run - select a single Partner to see Top Content.",
      });
    } else {
      sections.push(buildGenericTable(`${titleCaseFromCamel(platform)} Top Content (recent, single-Partner run)`, topContent, { sectionType: "top_n_content", note: "Ranked by recency, not a platform metric - this family's Content source has no per-platform view/engagement figure of its own." }));
    }
  }

  // 11. Data Coverage & Quality.
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

  // 12. Partner Account Directory / Appendix.
  const byPartner = new Map<string, ReportRow>();
  for (const row of result.rows) {
    const key = String(row.partnerRef);
    const entry = byPartner.get(key) ?? { partnerRef: row.partnerRef, partnerDisplayName: row.partnerDisplayName };
    entry[`hasAccount_${row.platform}`] = true;
    entry[`accountCount_${row.platform}`] = row.accountCount;
    byPartner.set(key, entry);
  }
  sections.push(buildGenericTable("Partner Account Directory / Appendix", [...byPartner.values()], { sectionType: "account_directory" }));

  return sections;
}
