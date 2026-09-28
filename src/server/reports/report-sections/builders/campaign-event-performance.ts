import type { ReportDefinition, ReportResult, ReportRow } from "../../types";
import { buildDataQualitySection } from "../data-quality";
import { buildCoverSection, buildGenericTable, buildKpiSummaryFromMetrics, titleCaseFromCamel } from "../helpers";
import { buildTopNContentTable, type TopNItem } from "../top-n";
import type { ReportSectionModel, ReportTableSection } from "../types";

// Reports Final-Master (spec sections 5B/5C): FULL bespoke treatment for Campaign / Event
// Performance - ONE evidence family (families/campaign-event-performance.ts, unchanged) backing TWO
// publication templates (Detailed and Compact), differentiated only by which sections this builder
// composes. See report-templates.ts's own comment on the reportId/templateId distinction.
const PLATFORMS = ["instagram", "youtube"] as const;

function unavailableTable(sectionType: ReportTableSection["sectionType"], title: string, reason: string): ReportTableSection {
  return { kind: "table", sectionType, mode: "EVIDENCE", title, unavailableReason: reason, columns: [], rows: [], emptyMessage: reason };
}

export function buildCampaignEventPerformanceSections(definition: ReportDefinition, result: ReportResult, templateTitle: string, variant: "standard" | "compact"): ReportSectionModel[] {
  const sections: ReportSectionModel[] = [];
  const sectionsObj = result.sections as Record<string, unknown>;

  // 1. Cover.
  sections.push(buildCoverSection({ definition, templateTitle, result }));

  // 2. Scale & Reach.
  sections.push(buildKpiSummaryFromMetrics("Scale & Reach", result.metrics));

  if (variant === "standard") {
    // 3. Platform Performance.
    const contentByPlatform = (sectionsObj.contentByPlatform as Record<string, { matchedContentCount: number; views: number | null; engagement: number | null }>) ?? {};
    sections.push(
      buildGenericTable(
        "Platform Performance",
        PLATFORMS.map((platform) => ({ platform, matchedContentCount: contentByPlatform[platform]?.matchedContentCount ?? 0, views: contentByPlatform[platform]?.views ?? null, engagement: contentByPlatform[platform]?.engagement ?? null })),
        { sectionType: "platform_comparison" },
      ),
    );

    // 4. TG / region / team breakdown - honestly unavailable (see recon: no such dimension is
    // composed by this family's own evidence today; never fabricated).
    sections.push(unavailableTable("tg_region_team_breakdown", "TG / Region / Team Breakdown", "Not available: this family's composed evidence carries no TG/region/team tag on Assignment or Content today. Marked unavailable rather than fabricated - see spec section 10."));

    // 5. Language breakdown - same honesty.
    sections.push(unavailableTable("language_breakdown", "Language Breakdown", "Not available: no language field is composed by this family's evidence today. Marked unavailable rather than fabricated."));
  }

  // 6. Top contributing Partners (Views, separately Engagement - never blended).
  const contributorsByViews = (sectionsObj.contributorsByViews as Record<string, ReportRow[]>) ?? {};
  const contributorsByEngagement = (sectionsObj.contributorsByEngagement as Record<string, ReportRow[]>) ?? {};
  for (const platform of PLATFORMS) {
    const viewsRows = contributorsByViews[platform] ?? [];
    const engagementRows = contributorsByEngagement[platform] ?? [];
    if (viewsRows.length > 0) sections.push(buildGenericTable(`Top Contributing Partners by Views (${titleCaseFromCamel(platform)})`, viewsRows, { sectionType: "partner_contribution" }));
    if (engagementRows.length > 0) sections.push(buildGenericTable(`Top Contributing Partners by Engagement (${titleCaseFromCamel(platform)})`, engagementRows, { sectionType: "partner_contribution" }));
  }

  // 7 (Detailed) / 3 (Compact). Top performing Content, from the trajectory's own individual matched
  // content data points (each point already carries views/engagement).
  const trajectoryByPlatform = (sectionsObj.trajectoryByPlatform as Record<string, ReportRow[]>) ?? {};
  for (const platform of PLATFORMS) {
    const points = trajectoryByPlatform[platform] ?? [];
    const items: TopNItem[] = points.map((p) => ({
      label: `${p.partnerLabel ?? "Unknown Partner"} (${p.publishedAt ?? "undated"})`,
      metricValue: typeof p.views === "number" ? p.views : null,
      context: typeof p.engagement === "number" ? `Engagement: ${p.engagement}` : null,
      url: typeof p.partnerAnalyticsHref === "string" ? p.partnerAnalyticsHref : null,
    }));
    sections.push(buildTopNContentTable({ title: "Top Performing Content", metricLabel: "Views", items, n: variant === "compact" ? 5 : 10, platformOrContext: titleCaseFromCamel(platform) }));
  }

  if (variant === "standard") {
    // 8. TG/region-specific rankings - same honest unavailability as section 4.
    sections.push(unavailableTable("ranked_table", "TG/Region-Specific Rankings", "Not available: no TG/region dimension is composed by this family's evidence today. Marked unavailable rather than fabricated."));

    // 10. Annexure with governed Content links.
    const contentRows = (sectionsObj.content as ReportRow[] | undefined) ?? [];
    sections.push(buildGenericTable("Annexure - Content", contentRows, { sectionType: "annexure", note: "Content refs are opaque CreatorOps references - no raw internal id or storage locator is ever shown." }));
  }

  // Data Quality is always included (spec section 10: every finalized management report must
  // include or expose it), regardless of variant.
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
