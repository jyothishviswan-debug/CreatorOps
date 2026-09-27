// Reports Final-Master (spec section 6): the reusable declarative report-section framework.
//
// Architecture decision (disclosed in the completion report): the spec's 22 named section kinds are
// each a distinct, purpose-named CONSTRUCTIBLE section type at the model level (own builder, own
// required fields, own test) - never hand-merged into one another. Underneath, every one of the 22
// renders through exactly ONE of five shared visual primitives (`cover`, `kpi_summary`, `kpi_cards`,
// `table`, `narrative`, `data_quality`) that the PDF/XLSX renderers implement ONCE - the same "many
// components, few primitives" discipline a real print design system uses. `sectionType` preserves the
// specific spec vocabulary for traceability and tests even though several sectionTypes share a `kind`.
//
// A ReportSectionModel is PURE DATA (no rendering logic, no pdf-lib/xlsx import) - the same model
// feeds the PDF renderer, the XLSX renderer, the CSV renderer and the web Evidence Preview UI.
export type ReportSectionMode = "EVIDENCE" | "NARRATIVE" | "MIXED_WITH_EVIDENCE_REFS";

export const REPORT_SECTION_TYPES = [
  "cover",
  "kpi_summary",
  "kpi_cards",
  "platform_comparison",
  "partner_performance_table",
  "source_metric_leaders",
  "ranked_table",
  "top_n_content",
  "performance_band_distribution",
  "daily_trajectory",
  "monthly_trajectory",
  "campaign_phase_trajectory",
  "language_breakdown",
  "tg_region_team_breakdown",
  "narrative_topic_breakdown",
  "partner_contribution",
  "content_highlight",
  "pilot_programme_highlight",
  "data_quality",
  "account_directory",
  "annexure",
  "narrative_section",
  "conclusion",
] as const;
export type ReportSectionType = (typeof REPORT_SECTION_TYPES)[number];

export type TableColumn = { id: string; label: string; numeric?: boolean };
export type TableRow = Record<string, string | number | boolean | null>;

export type ReportKpiItem = { label: string; value: string; unavailable?: boolean };
export type ReportKpiCard = { label: string; value: string; sublabel?: string; unavailable?: boolean };

type SectionBase = { sectionType: ReportSectionType; mode: ReportSectionMode; title: string; unavailableReason?: string };

export type ReportCoverSection = SectionBase & {
  kind: "cover";
  sectionType: "cover";
  mode: "EVIDENCE";
  subtitle: string;
  scopeLine: string;
  periodLine: string;
  generatedAtLine: string;
  evidenceCutoffLine: string;
};

export type ReportKpiSummarySection = SectionBase & { kind: "kpi_summary"; items: ReportKpiItem[] };
export type ReportKpiCardsSection = SectionBase & { kind: "kpi_cards"; cards: ReportKpiCard[] };

export type ReportTableSection = SectionBase & {
  kind: "table";
  note?: string;
  columns: TableColumn[];
  rows: TableRow[];
  totalsRow?: TableRow;
  emptyMessage?: string;
  landscape?: boolean;
};

export type ReportNarrativeSection = SectionBase & {
  kind: "narrative";
  mode: "NARRATIVE";
  body: string;
  evidenceRefs?: string[];
  reviewStatus?: string;
  editable: true;
  sectionKey: string;
};

export type ReportDataQualitySection = SectionBase & {
  kind: "data_quality";
  mode: "EVIDENCE";
  items: ReportKpiItem[];
  warnings: string[];
};

export type ReportSectionModel = ReportCoverSection | ReportKpiSummarySection | ReportKpiCardsSection | ReportTableSection | ReportNarrativeSection | ReportDataQualitySection;

export function isEditableNarrativeSection(section: ReportSectionModel): section is ReportNarrativeSection {
  return section.kind === "narrative";
}
