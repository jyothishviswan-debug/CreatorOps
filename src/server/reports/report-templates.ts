import { z } from "zod";

import type { ReportArtifactFormat, ReportId } from "./types";

// Reports Final-Master (spec section 5): the management report TEMPLATE catalog - 7 publication
// templates, deliberately a DIFFERENT concept from the 13 `ReportId` evidence families (catalog.ts).
// A `reportId` is "which source composition runs" (unchanged, section 21: keep every existing
// executor). A `reportTemplateId` is "which publication shape (section set + narrative + artifacts)
// is composed from that evidence" - the same distinction a real publishing house draws between "the
// data pull" and "the layout it goes into". This lets ONE evidence family back more than one
// publication template (Campaign / Event Performance backs three: Detailed, Compact and
// Weekly/Rapid-Response - see report-sections/build-sections.ts) without duplicating source
// composition code, and is the disclosed architectural decision behind this stage's template catalog.
// Spec section 5's 7 required MANAGEMENT templates.
const MANAGEMENT_TEMPLATE_IDS = ["monthly_partner_performance", "campaign_event_performance_detailed", "campaign_event_performance_compact", "weekly_rapid_response_programme", "cross_platform_partner_programme", "long_period_partner_programme", "partner_portfolio_coverage"] as const;

// Spec section 21: "reconcile ALL existing 13 report families" - attach the SAME lifecycle/narrative/
// artifact machinery to the remaining 7 reportIds that are not one of the 7 management templates
// above (partner_portfolio already has a dedicated management template - "partner_portfolio_coverage"
// - so it is not repeated here). Each gets a 1:1 baseline-treatment template (own templateId equal to
// its reportId, for clarity) so every one of the 13 report families can genuinely go through
// Draft -> Evidence -> Narrative -> Review -> Finalize -> Artifacts -> Version History, not just the
// 7 named management templates - disclosed explicitly in the completion report.
const RECONCILED_BASELINE_TEMPLATE_IDS = ["campaign_delivery", "channel_growth_freshness", "partner_review_evidence", "finance_status", "operations_attention", "discovery_funnel", "administration_security"] as const;

export const REPORT_TEMPLATE_IDS = [...MANAGEMENT_TEMPLATE_IDS, ...RECONCILED_BASELINE_TEMPLATE_IDS] as const;
export const reportTemplateIdSchema = z.enum(REPORT_TEMPLATE_IDS);
export type ReportTemplateId = z.infer<typeof reportTemplateIdSchema>;

export function isReportTemplateId(value: unknown): value is ReportTemplateId {
  return typeof value === "string" && (REPORT_TEMPLATE_IDS as readonly string[]).includes(value);
}

// Spec section 4/14's narrative section-type vocabulary.
export const REPORT_NARRATIVE_SECTION_KEYS = ["executive_summary", "context", "performance_interpretation", "content_highlight", "strategic_editorial_insight", "conclusion", "data_quality_note"] as const;
export const reportNarrativeSectionKeySchema = z.enum(REPORT_NARRATIVE_SECTION_KEYS);
export type ReportNarrativeSectionKey = z.infer<typeof reportNarrativeSectionKeySchema>;

export const NARRATIVE_SECTION_LABELS: Record<ReportNarrativeSectionKey, string> = {
  executive_summary: "Executive Summary",
  context: "Context",
  performance_interpretation: "Performance Interpretation",
  content_highlight: "Content Highlight / Case Study",
  strategic_editorial_insight: "Strategic / Editorial Insight",
  conclusion: "Conclusion",
  data_quality_note: "Data Quality Note",
};

export type ReportTemplateDefinition = {
  templateId: ReportTemplateId;
  reportId: ReportId;
  title: string;
  referencePattern: string;
  // "compact" templates additionally cap Top-N/leader lists more tightly and omit some
  // detail-only sections, per spec 5C's "aim for approximately 2-3 A4 pages when data volume
  // permits - do not force data to fit an arbitrary page count."
  variant: "standard" | "compact";
  requiredNarrativeSectionKeys: ReportNarrativeSectionKey[];
  artifactFormats: ReportArtifactFormat[];
  // Whether this stage gave the template FULL bespoke section-model treatment (a purpose-built
  // section builder covering its own numbered section list) vs a baseline/generic composition of the
  // underlying family's existing ReportResult. Disclosed explicitly in the completion report - see
  // report-sections/build-sections.ts.
  treatment: "full" | "baseline";
  // Reports PDF Composition & Management-Publication Polish (spec section 2): the PDF page orientation
  // this template's publication is designed for. A single, deliberate, per-TEMPLATE property - never a
  // report-id conditional scattered through the renderer (see pdf-renderer.ts's pageSizeFor). Defaults
  // to "portrait" for every template except monthly_partner_performance, whose reference report (a wide
  // multi-column analytical management document, confirmed via its own PDF mediabox) is landscape.
  orientation: "portrait" | "landscape";
};

const REPORT_TEMPLATE_CATALOG: Record<ReportTemplateId, ReportTemplateDefinition> = {
  monthly_partner_performance: {
    templateId: "monthly_partner_performance",
    reportId: "monthly_partner_performance",
    title: "Monthly Partner Performance",
    referencePattern: "Monthly_Creator_Productivity_Report_August_2026",
    variant: "standard",
    requiredNarrativeSectionKeys: ["executive_summary", "conclusion"],
    artifactFormats: ["pdf", "xlsx", "csv"],
    treatment: "full",
    // Spec section 2: the reference Monthly report's own PDF mediabox is landscape (confirmed via
    // pypdf) - a wide, many-column analytical management document. This is the ONE template with a
    // non-default orientation.
    orientation: "landscape",
  },
  campaign_event_performance_detailed: {
    templateId: "campaign_event_performance_detailed",
    reportId: "campaign_event_performance",
    title: "Campaign / Event Performance - Detailed",
    referencePattern: "Partnership_Programme_Campaign_Report_on_Chhathron_Ki_Goonj",
    variant: "standard",
    requiredNarrativeSectionKeys: ["executive_summary", "conclusion"],
    artifactFormats: ["pdf", "xlsx", "csv"],
    treatment: "full",
    orientation: "portrait",
  },
  campaign_event_performance_compact: {
    templateId: "campaign_event_performance_compact",
    reportId: "campaign_event_performance",
    title: "Campaign / Event Performance - Compact",
    referencePattern: "Campaign_Report_On_T_Narasipura_Ganesha_Procession_Issue / Kannada_Creators_Ganesh_Festival_Performance_Report",
    variant: "compact",
    requiredNarrativeSectionKeys: ["executive_summary"],
    artifactFormats: ["pdf", "xlsx"],
    treatment: "full",
    orientation: "portrait",
  },
  weekly_rapid_response_programme: {
    templateId: "weekly_rapid_response_programme",
    reportId: "campaign_performance",
    title: "Weekly / Rapid-Response Programme Performance",
    referencePattern: "IG Partner_Performance_Report_CJP_Protest",
    variant: "compact",
    requiredNarrativeSectionKeys: ["executive_summary", "strategic_editorial_insight", "conclusion"],
    artifactFormats: ["pdf", "xlsx"],
    treatment: "baseline",
    orientation: "portrait",
  },
  cross_platform_partner_programme: {
    templateId: "cross_platform_partner_programme",
    reportId: "cross_platform_partner_programme",
    title: "Cross-Platform Partner / Programme Performance",
    referencePattern: "Youtube Partner Programme_ Performance Report",
    variant: "standard",
    requiredNarrativeSectionKeys: ["executive_summary", "conclusion"],
    artifactFormats: ["pdf", "xlsx", "csv"],
    treatment: "full",
    orientation: "portrait",
  },
  long_period_partner_programme: {
    templateId: "long_period_partner_programme",
    reportId: "long_period_partner_programme",
    title: "Long-Period Partner Programme",
    referencePattern: "cross-platform + monthly references",
    variant: "standard",
    requiredNarrativeSectionKeys: ["executive_summary"],
    artifactFormats: ["pdf", "xlsx", "csv"],
    treatment: "baseline",
    orientation: "portrait",
  },
  partner_portfolio_coverage: {
    templateId: "partner_portfolio_coverage",
    reportId: "partner_portfolio",
    title: "Partner Portfolio / Coverage",
    referencePattern: "Active_PP_Partner_Tracker - IG Partners - India1 and South (sanitized)",
    variant: "standard",
    requiredNarrativeSectionKeys: [],
    artifactFormats: ["pdf", "xlsx", "csv"],
    treatment: "baseline",
    orientation: "portrait",
  },
  // --- Spec section 21 reconciliation: the remaining 7 original report families, given the SAME
  // lifecycle/narrative/artifact machinery via the generic baseline builder (see build-sections.ts) -
  // not bespoke management templates in their own right, but genuinely NOT isolated one-off executors
  // any more either: each can be drafted, reviewed, finalized, and produces real governed PDF/XLSX/CSV
  // artifacts through the exact same publication pipeline. ---
  campaign_delivery: { templateId: "campaign_delivery", reportId: "campaign_delivery", title: "Campaign Delivery", referencePattern: "n/a - reconciled original family, spec section 21", variant: "standard", requiredNarrativeSectionKeys: [], artifactFormats: ["pdf", "xlsx", "csv"], treatment: "baseline", orientation: "portrait" },
  channel_growth_freshness: { templateId: "channel_growth_freshness", reportId: "channel_growth_freshness", title: "Channel Growth & Freshness", referencePattern: "n/a - reconciled original family, spec section 21", variant: "standard", requiredNarrativeSectionKeys: [], artifactFormats: ["pdf", "xlsx", "csv"], treatment: "baseline", orientation: "portrait" },
  partner_review_evidence: { templateId: "partner_review_evidence", reportId: "partner_review_evidence", title: "Partner Review Evidence", referencePattern: "n/a - reconciled original family, spec section 21", variant: "standard", requiredNarrativeSectionKeys: [], artifactFormats: ["pdf", "xlsx", "csv"], treatment: "baseline", orientation: "portrait" },
  finance_status: { templateId: "finance_status", reportId: "finance_status", title: "Finance Status", referencePattern: "n/a - reconciled original family, spec section 21", variant: "standard", requiredNarrativeSectionKeys: [], artifactFormats: ["pdf", "xlsx", "csv"], treatment: "baseline", orientation: "portrait" },
  operations_attention: { templateId: "operations_attention", reportId: "operations_attention", title: "Operations Attention", referencePattern: "n/a - reconciled original family, spec section 21", variant: "standard", requiredNarrativeSectionKeys: [], artifactFormats: ["pdf", "xlsx", "csv"], treatment: "baseline", orientation: "portrait" },
  discovery_funnel: { templateId: "discovery_funnel", reportId: "discovery_funnel", title: "Discovery Funnel", referencePattern: "n/a - reconciled original family, spec section 21", variant: "standard", requiredNarrativeSectionKeys: [], artifactFormats: ["pdf", "xlsx", "csv"], treatment: "baseline", orientation: "portrait" },
  administration_security: { templateId: "administration_security", reportId: "administration_security", title: "Administration & Security", referencePattern: "n/a - reconciled original family, spec section 21", variant: "standard", requiredNarrativeSectionKeys: [], artifactFormats: ["pdf", "xlsx", "csv"], treatment: "baseline", orientation: "portrait" },
};

export function getReportTemplateDefinition(templateId: ReportTemplateId): ReportTemplateDefinition {
  return REPORT_TEMPLATE_CATALOG[templateId];
}

export function listReportTemplateDefinitions(): ReportTemplateDefinition[] {
  return Object.values(REPORT_TEMPLATE_CATALOG);
}
