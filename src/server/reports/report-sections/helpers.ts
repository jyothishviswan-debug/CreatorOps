import type { ReportDefinition, ReportResult, ReportRow } from "../types";
import type { ReportCoverSection, ReportKpiItem, ReportKpiSummarySection, ReportTableSection, TableColumn } from "./types";

// Shared, small formatting/assembly helpers used by every template's section builder - kept here
// rather than duplicated per-builder, per spec section 6's "do not hand-code seven unrelated PDFs".
export function titleCaseFromCamel(id: string): string {
  const spaced = id.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatMetricValue(value: number | string | null): string {
  if (value === null) return "Not available";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("en-IN") : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return value;
}

export function buildCoverSection(params: { definition: ReportDefinition; templateTitle: string; result: ReportResult; scopeLine?: string }): ReportCoverSection {
  return {
    kind: "cover",
    sectionType: "cover",
    mode: "EVIDENCE",
    title: params.templateTitle,
    subtitle: params.definition.purpose,
    scopeLine: params.scopeLine ?? params.result.scopeSummary.note,
    periodLine: params.result.appliedFilters.period ? `Period: ${params.result.appliedFilters.period}` : params.result.appliedFilters.periods ? `Periods: ${params.result.appliedFilters.periods}` : "Period: not filtered (full actor scope)",
    generatedAtLine: `Generated: ${params.result.generatedAt}`,
    evidenceCutoffLine: `Evidence cutoff: ${params.result.evidenceCutoff}`,
  };
}

export function buildKpiSummaryFromMetrics(title: string, metrics: Record<string, number | string | null>): ReportKpiSummarySection {
  const items: ReportKpiItem[] = Object.entries(metrics).map(([id, value]) => ({ label: titleCaseFromCamel(id), value: formatMetricValue(value), unavailable: value === null }));
  return { kind: "kpi_summary", sectionType: "kpi_summary", mode: "EVIDENCE", title, items };
}

// Generic row->table conversion used by the baseline template treatment (see build-sections.ts) and
// by any full builder that has an already-shaped ReportRow[] section it wants to show verbatim.
export function buildGenericTable(title: string, rows: ReportRow[], options?: { note?: string; maxRows?: number; sectionType?: ReportTableSection["sectionType"] }): ReportTableSection {
  const cap = options?.maxRows ?? 100;
  const bounded = rows.slice(0, cap);
  const columnIds = bounded.length > 0 ? Object.keys(bounded[0]!) : [];
  const columns: TableColumn[] = columnIds.map((id) => ({ id, label: titleCaseFromCamel(id), numeric: bounded.every((r) => typeof r[id] === "number" || r[id] === null) }));
  return {
    kind: "table",
    sectionType: options?.sectionType ?? "ranked_table",
    mode: "EVIDENCE",
    title,
    note: rows.length > cap ? `Showing the first ${cap} of ${rows.length} rows.` : options?.note,
    columns,
    rows: bounded,
    emptyMessage: "No rows in this run.",
  };
}
