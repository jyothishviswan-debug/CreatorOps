// Reports Final-Master (spec section 10): the Data Coverage & Quality section every finalized
// management report must include. Built ONLY from fields the underlying ReportResult/family already
// discloses (truncated, limitations, provenance, rowCount/maxRows) plus whatever counts the caller
// supplies - never re-derived by guessing at a source module's internals. Missing != zero,
// unavailable != zero, unsupported != estimated (section 10) - every item below is either a real
// count or an explicit "not available" string, never a fabricated number.
import type { ReportProvenanceEntry } from "../types";
import type { ReportDataQualitySection, ReportKpiItem } from "./types";

export type DataQualityInput = {
  generatedAt: string;
  evidenceCutoff: string;
  truncated: boolean;
  rowCount: number;
  maxRows: number;
  limitations: string[];
  provenance: ReportProvenanceEntry[];
  unavailableMetrics?: string[];
  expectedPartnerCount?: number | null;
  includedPartnerCount?: number | null;
  missingAccountCount?: number | null;
  correctionsApplied?: string[];
};

export function buildDataQualitySection(input: DataQualityInput): ReportDataQualitySection {
  const items: ReportKpiItem[] = [
    { label: "Report generated at", value: input.generatedAt },
    { label: "Evidence cutoff (source freshness)", value: input.evidenceCutoff },
    { label: "Rows returned / bound", value: `${input.rowCount} / ${input.maxRows}` },
    { label: "Truncated (more evidence exists than shown)", value: input.truncated ? "Yes" : "No" },
  ];
  if (input.expectedPartnerCount !== undefined && input.expectedPartnerCount !== null) {
    items.push({ label: "Expected Partners", value: String(input.expectedPartnerCount) });
  }
  if (input.includedPartnerCount !== undefined && input.includedPartnerCount !== null) {
    items.push({ label: "Included Partners", value: String(input.includedPartnerCount) });
  }
  if (input.missingAccountCount !== undefined && input.missingAccountCount !== null) {
    items.push({ label: "Missing/stale Partner Accounts", value: String(input.missingAccountCount) });
  }
  for (const source of input.provenance) {
    items.push({ label: `Source: ${source.sourceModule}.${source.sourceFunction}`, value: `${source.recordCount} record(s)${source.scanned !== undefined ? ` (scanned ${source.scanned})` : ""}` });
  }
  const unavailableMetrics = input.unavailableMetrics ?? [];
  for (const metricId of unavailableMetrics) {
    items.push({ label: `Metric unavailable: ${metricId}`, value: "Not available (never estimated)", unavailable: true });
  }
  const correctionsApplied = input.correctionsApplied ?? [];
  if (correctionsApplied.length > 0) {
    items.push({ label: "Corrections applied", value: correctionsApplied.join("; ") });
  }
  return {
    kind: "data_quality",
    sectionType: "data_quality",
    mode: "EVIDENCE",
    title: "Data Coverage & Quality",
    items,
    warnings: input.limitations,
  };
}
