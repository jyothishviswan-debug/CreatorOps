import { getReportDefinition } from "./catalog";
import type { AppliedReportFilters, ReportId, ReportProvenanceEntry, ReportResult, ReportRow, ReportScopeSummary } from "./types";

// Step 19A: the one place a family projector assembles its final ReportResult - guarantees every
// family stamps the same definitionVersion/maxRows/base-limitations the catalog declares (section
// 5's normalized result contract), so no family can silently diverge from its own definition.
export function buildReportResult(params: {
  reportId: ReportId;
  generatedAt: string;
  evidenceCutoff: string;
  appliedFilters: AppliedReportFilters;
  scopeSummary: ReportScopeSummary;
  metrics: Record<string, number | string | null>;
  rows: ReportRow[];
  sections: Record<string, unknown>;
  extraLimitations?: string[];
  truncated: boolean;
  rowCount: number;
  provenance: ReportProvenanceEntry[];
}): ReportResult {
  const definition = getReportDefinition(params.reportId);
  return {
    reportId: params.reportId,
    definitionVersion: definition.version,
    generatedAt: params.generatedAt,
    evidenceCutoff: params.evidenceCutoff,
    appliedFilters: params.appliedFilters,
    scopeSummary: params.scopeSummary,
    metrics: params.metrics,
    rows: params.rows,
    sections: params.sections,
    limitations: [...definition.limitations, ...(params.extraLimitations ?? [])],
    truncated: params.truncated,
    rowCount: params.rowCount,
    maxRows: definition.maxRows,
    provenance: params.provenance,
  };
}
