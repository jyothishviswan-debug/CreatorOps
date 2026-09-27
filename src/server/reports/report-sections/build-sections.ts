import type { ReportDefinition, ReportResult } from "../types";
import { getReportTemplateDefinition, NARRATIVE_SECTION_LABELS, type ReportNarrativeSectionKey, type ReportTemplateId } from "../report-templates";
import { buildCampaignEventPerformanceSections } from "./builders/campaign-event-performance";
import { buildCrossPlatformPartnerProgrammeSections } from "./builders/cross-platform-partner-programme";
import { buildMonthlyPartnerPerformanceSections } from "./builders/monthly-partner-performance";
import { buildDataQualitySection } from "./data-quality";
import { buildCoverSection, buildGenericTable, buildKpiSummaryFromMetrics } from "./helpers";
import type { ReportNarrativeSection as NarrativeSectionModel, ReportSectionModel } from "./types";

// Reports Final-Master (spec section 6): the ONE dispatch point that turns a template id + its
// already-governed ReportResult into the reusable declarative section model. Every route/service that
// needs Evidence Preview / PDF / XLSX / CSV content calls through here - never a bespoke per-route
// section-building duplicate.

// Baseline treatment (disclosed in report-templates.ts's own `treatment: "baseline"` flag): a
// genuinely working, introspective composition of whatever the underlying ReportResult already
// discloses - cover, a KPI summary from `metrics`, one table per array-of-objects entry in
// `sections`, and Data Quality. Real and useful, just not hand-tailored to a reference PDF's own
// exact named section list the way the four "full" treatment templates are - see the completion
// report for exactly which templates got which treatment and why.
function buildBaselineSections(definition: ReportDefinition, result: ReportResult, templateTitle: string): ReportSectionModel[] {
  const sections: ReportSectionModel[] = [buildCoverSection({ definition, templateTitle, result }), buildKpiSummaryFromMetrics("Summary Metrics", result.metrics)];
  for (const [key, value] of Object.entries(result.sections)) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null && !Array.isArray(value[0])) {
      sections.push(buildGenericTable(key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()), value as Record<string, string | number | boolean | null>[], {}));
    }
  }
  sections.push(buildDataQualitySection({ generatedAt: result.generatedAt, evidenceCutoff: result.evidenceCutoff, truncated: result.truncated, rowCount: result.rowCount, maxRows: result.maxRows, limitations: result.limitations, provenance: result.provenance }));
  return sections;
}

// Dispatches on the template's own disclosed `treatment` flag (spec: "document explicitly which
// templates got full treatment and which are partial") - a "full" template MUST have a case below;
// every "baseline" template (whether one of the 3 management templates given baseline treatment, or
// one of the 7 original families reconciled under spec section 21) automatically gets the generic,
// genuinely-working introspective composition, with no per-template registration required.
export function buildEvidenceSections(templateId: ReportTemplateId, definition: ReportDefinition, result: ReportResult): ReportSectionModel[] {
  const template = getReportTemplateDefinition(templateId);
  if (template.treatment === "baseline") return buildBaselineSections(definition, result, template.title);

  switch (templateId) {
    case "monthly_partner_performance":
      return buildMonthlyPartnerPerformanceSections(definition, result, template.title);
    case "campaign_event_performance_detailed":
      return buildCampaignEventPerformanceSections(definition, result, template.title, "standard");
    case "campaign_event_performance_compact":
      return buildCampaignEventPerformanceSections(definition, result, template.title, "compact");
    case "cross_platform_partner_programme":
      return buildCrossPlatformPartnerProgrammeSections(definition, result, template.title);
    default:
      throw new Error(`Template "${templateId}" is marked "full" treatment in report-templates.ts but has no bespoke builder registered here.`);
  }
}

export type NarrativeAssemblyEntry = { title: string; body: string; reviewStatus: string; evidenceRefs?: string[] };

// Interleaves the pinned/edited narrative bodies into the evidence section list in a fixed, sensible
// reading order (Executive Summary immediately after the cover; Conclusion always last) - this is the
// ONE place narrative and evidence are combined into the final publication order used by the PDF/XLSX
// renderer and the read-only Evidence Preview. Narrative content NEVER alters an evidence section's
// own fields (spec section 4: "Narrative may cite evidence but may not change the evidence").
const LEADING_KEYS: ReportNarrativeSectionKey[] = ["executive_summary"];
const TRAILING_KEYS: ReportNarrativeSectionKey[] = ["conclusion", "data_quality_note"];

export function assembleFullReportSections(evidenceSections: ReportSectionModel[], narrativeByKey: Partial<Record<ReportNarrativeSectionKey, NarrativeAssemblyEntry>>): ReportSectionModel[] {
  function toModel(key: ReportNarrativeSectionKey, entry: NarrativeAssemblyEntry): NarrativeSectionModel {
    return {
      kind: "narrative",
      sectionType: key === "conclusion" ? "conclusion" : "narrative_section",
      mode: "NARRATIVE",
      title: entry.title || NARRATIVE_SECTION_LABELS[key],
      body: entry.body,
      evidenceRefs: entry.evidenceRefs,
      reviewStatus: entry.reviewStatus,
      editable: true,
      sectionKey: key,
    };
  }

  const leading = LEADING_KEYS.filter((k) => narrativeByKey[k]).map((k) => toModel(k, narrativeByKey[k]!));
  const trailing = TRAILING_KEYS.filter((k) => narrativeByKey[k]).map((k) => toModel(k, narrativeByKey[k]!));
  const middleKeys = (Object.keys(narrativeByKey) as ReportNarrativeSectionKey[]).filter((k) => !LEADING_KEYS.includes(k) && !TRAILING_KEYS.includes(k));
  const middle = middleKeys.map((k) => toModel(k, narrativeByKey[k]!));

  const [cover, ...rest] = evidenceSections;
  return [...(cover ? [cover] : []), ...leading, ...rest, ...middle, ...trailing];
}
