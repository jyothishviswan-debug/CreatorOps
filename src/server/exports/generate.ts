import { generateCsv } from "./csv";
import { generatePdf, PDF_MAX_ROWS } from "./pdf";
import type { ExportColumnDef, ExportFormat, ExportRow } from "./types";
import { generateXlsx } from "./xlsx";

// Format generation dispatch. Uses the SAME governed target/column/scope decision every caller
// already made (columns + rows are handed in, already validated/fetched upstream in
// export-service.ts) - never an independent per-format authorization path, per the spec's explicit
// "format generation must use the same governed decision, not independent per-format authorization".
export const MIME_TYPE_BY_FORMAT: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

export const FILE_EXTENSION_BY_FORMAT: Record<ExportFormat, string> = {
  csv: "csv",
  xlsx: "xlsx",
  pdf: "pdf",
};

export type GenerateContext = {
  targetTitle: string;
  appliedFilters: Record<string, string>;
  generatedAt: string;
  maxRows: number;
  truncated: boolean;
};

export async function generateExportBytes(format: ExportFormat, columns: ExportColumnDef[], rows: ExportRow[], context: GenerateContext): Promise<{ bytes: Uint8Array; rowsWritten: number }> {
  if (format === "csv") {
    const text = generateCsv(columns, rows);
    return { bytes: new TextEncoder().encode(text), rowsWritten: rows.length };
  }
  if (format === "xlsx") {
    return { bytes: generateXlsx(columns, rows), rowsWritten: rows.length };
  }
  // pdf
  const pdfRowLimitApplied = rows.length > PDF_MAX_ROWS;
  const pdfRows = pdfRowLimitApplied ? rows.slice(0, PDF_MAX_ROWS) : rows;
  const bytes = await generatePdf(columns, pdfRows, {
    targetTitle: context.targetTitle,
    format,
    appliedFilters: context.appliedFilters,
    generatedAt: context.generatedAt,
    rowCount: rows.length,
    maxRows: context.maxRows,
    truncated: context.truncated,
    pdfRowLimitApplied,
  });
  return { bytes, rowsWritten: pdfRows.length };
}
