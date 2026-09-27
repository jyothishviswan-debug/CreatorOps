import { generateCsv } from "../../exports/csv";
import type { ReportSectionModel, ReportTableSection } from "../report-sections/types";

// Reports Final-Master (spec section 19): CSV is optional per ReportDefinition and, when supported,
// exports EXACTLY ONE declared evidence table - never the whole complex report flattened into one
// incoherent file. Reuses exports/csv.ts's own already-reviewed generateCsv/formula-injection
// mitigation directly (TableColumn/TableRow are structurally identical to ExportColumnDef/ExportRow -
// see that file's own comment for the mitigation's reasoning). Narrative text is never included in a
// report CSV in this stage (no ReportDefinition here declares a narrative CSV field - spec section
// 19's own "omit narrative text unless the definition explicitly calls for a narrative CSV field").

// A per-template preferred CSV section, by title substring (case-insensitive) - the disclosed,
// deterministic policy this stage uses to pick "exactly which evidence table" per spec section 19.
// Falls back to the first available (non-unavailable, non-empty) table section in section order.
const PREFERRED_CSV_SECTION_TITLE_SUBSTRING: Record<string, string> = {
  monthly_partner_performance: "Instagram Partner Performance",
  campaign_event_performance_detailed: "Annexure - Content",
  cross_platform_partner_programme: "Cross-Platform Partner Contribution",
  partner_portfolio_coverage: "Partners by status",
};

export function pickCsvSection(templateId: string, sections: ReportSectionModel[]): ReportTableSection | null {
  const preferredSubstring = PREFERRED_CSV_SECTION_TITLE_SUBSTRING[templateId];
  const tableSections = sections.filter((s): s is ReportTableSection => s.kind === "table" && !s.unavailableReason && s.rows.length > 0);
  if (preferredSubstring) {
    const preferred = tableSections.find((s) => s.title.toLowerCase().includes(preferredSubstring.toLowerCase()));
    if (preferred) return preferred;
  }
  return tableSections[0] ?? null;
}

export function generateReportCsv(templateId: string, sections: ReportSectionModel[]): { csv: string; sectionTitle: string } | null {
  const section = pickCsvSection(templateId, sections);
  if (!section) return null;
  const csv = generateCsv(
    section.columns.map((c) => ({ id: c.id, label: c.label })),
    section.rows,
  );
  return { csv, sectionTitle: section.title };
}
