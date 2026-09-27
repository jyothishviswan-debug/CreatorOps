import { combineMetricAcrossPlatforms } from "../../metric-compatibility";
import type { ReportDefinition, ReportResult, ReportRow } from "../../types";
import { buildDataQualitySection } from "../data-quality";
import { buildCoverSection, buildGenericTable, buildKpiSummaryFromMetrics } from "../helpers";
import type { ReportSectionModel, ReportTableSection } from "../types";

// Reports Final-Master (spec section 5E): FULL bespoke treatment for Cross-Platform Partner /
// Programme Performance. This family (families/cross-platform-partner-programme.ts, unchanged)
// already keeps every metric strictly per-platform except one explicitly-safe raw count - this
// builder makes that enforcement VISIBLE in the published report by running every candidate metric
// through the same combineMetricAcrossPlatforms gate execution code uses (spec section 11: "enforced
// in execution code, not merely explained in the UI" - the report explanation and the enforcement are
// the SAME function call here, not two independently-maintained claims).
const PLATFORMS = ["instagram", "youtube"] as const;

function unavailableTable(sectionType: ReportTableSection["sectionType"], title: string, reason: string): ReportTableSection {
  return { kind: "table", sectionType, mode: "EVIDENCE", title, unavailableReason: reason, columns: [], rows: [], emptyMessage: reason };
}

export function buildCrossPlatformPartnerProgrammeSections(definition: ReportDefinition, result: ReportResult, templateTitle: string): ReportSectionModel[] {
  const sections: ReportSectionModel[] = [];
  const metrics = result.metrics;

  // 1. Cover.
  sections.push(buildCoverSection({ definition, templateTitle, result }));

  // 2. Programme Scale & Reach by platform.
  sections.push(buildKpiSummaryFromMetrics("Programme Scale & Reach by Platform", metrics));

  // 3. Combined metrics only where semantically valid - built by calling the SAME enforcement
  // function execution uses, for every candidate metric, so the report and the code can never drift.
  const combinedRows: ReportRow[] = [];
  const numericByPlatform = (prefix: string): Record<string, number | null> => Object.fromEntries(PLATFORMS.map((p) => [p, typeof metrics[`${prefix}_${p}`] === "number" ? (metrics[`${prefix}_${p}`] as number) : null]));
  for (const metricId of ["publishedContentCount", "views", "engagement", "followers"] as const) {
    const values = metricId === "followers" ? Object.fromEntries(PLATFORMS.map((p) => [p, null])) : numericByPlatform(metricId);
    const outcome = combineMetricAcrossPlatforms(metricId, values);
    combinedRows.push({ metric: metricId, combinable: outcome.combined, combinedValue: outcome.combined ? outcome.value : null, reason: outcome.combined ? "Combined (see instructions in this report's Data Quality section)." : outcome.reason });
  }
  sections.push(buildGenericTable("Combined-Metric Compatibility", combinedRows, { sectionType: "platform_comparison", note: "Followers/Subscribers, Views and Engagement are never summed across platforms. publishedContentCount is the one metric this report combines - each Content item is published on exactly one platform." }));

  // 4. Monthly / phase progression - unavailable (this family has no per-period bucketing of its
  // own; see families/long-period-partner-programme.ts for the family that DOES).
  sections.push(unavailableTable("monthly_trajectory", "Monthly / Phase Progression", "Not available from this family's evidence: Cross-Platform Partner/Programme composes a single current snapshot, not a period-by-period series. Use Long-Period Partner Programme for a period trend."));

  // 5. Peak campaign-window trajectory - unavailable, same reason.
  sections.push(unavailableTable("campaign_phase_trajectory", "Peak Campaign-Window Trajectory", "Not available from this family's evidence: no trajectory/time-series data is composed by this family."));

  // 6. Top Content by platform - unavailable (this family composes Partner-level rollups only, no
  // individual Content rows).
  sections.push(unavailableTable("top_n_content", "Top Content by Platform", "Not available from this family's evidence: rows are Partner-level rollups, not individual Content items. Use Campaign / Event Performance or Monthly Partner Performance for Content-level Top-N."));

  // 7. Pilot/sub-programme highlights - unavailable (no such entity exists anywhere in this
  // product; never fabricated).
  sections.push(unavailableTable("pilot_programme_highlight", "Pilot / Sub-Programme Highlights", "Not available: no Pilot/sub-programme entity exists anywhere in this product. Never fabricated."));

  // 8. Cross-platform Partner contribution.
  sections.push(buildGenericTable("Cross-Platform Partner Contribution", result.rows, { sectionType: "partner_contribution" }));

  // 9. Data Quality.
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

  return sections;
}
