import { checkImportFileSafety } from "./file-safety";
import { classifyImportReasonCode, type ClassifiedImportError } from "./error-taxonomy";
// Reused directly - this parser is already domain-agnostic (generic
// sheet/header/row extraction with no Analytics-specific logic); see its
// own header comment. Not duplicated here.
import { parseWorkbookBuffer, type ParsedSheet } from "@/server/analytics/xlsx-parser";

// Import Center Completion (spec section 3, "File/Sheet Preview"): a
// generic, adapter-agnostic raw-file preview - bounded sample rows, sheet
// inventory, and structural parse warnings (duplicate/empty headers,
// blank trailing rows) computed BEFORE any domain adapter runs
// classification/matching. Used by every target's Upload -> Preview step
// (today: Analytics, contract-bundle); never mutates anything, and never
// runs a domain adapter's own matching logic.

const MAX_SAMPLE_ROWS = 10;

export type ImportSheetPreview = {
  sheetName: string;
  headers: string[];
  rowCount: number;
  sampleRows: Array<Record<string, unknown>>;
  sampleRowsTruncated: boolean;
  duplicateHeaders: string[];
  emptyHeaderCount: number;
  emptyRowCount: number;
  trailingEmptyRowCount: number;
};

export type ImportFilePreviewResult =
  | { ok: true; sheets: ImportSheetPreview[]; totalRowCount: number; warnings: string[] }
  | { ok: false; error: ClassifiedImportError };

function isRowEmpty(row: Record<string, unknown>): boolean {
  return Object.values(row).every((value) => value === null || value === undefined || (typeof value === "string" && value.trim().length === 0));
}

function countTrailingEmptyRows(rows: Array<Record<string, unknown>>): number {
  let count = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!isRowEmpty(rows[i]!)) break;
    count += 1;
  }
  return count;
}

function analyzeSheet(sheet: ParsedSheet): ImportSheetPreview {
  const seen = new Map<string, number>();
  const emptyHeaderCount = sheet.headers.filter((h) => h.trim().length === 0).length;
  for (const header of sheet.headers) {
    const key = header.trim().toLowerCase();
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicateHeaders = [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);

  const emptyRowCount = sheet.rows.filter(isRowEmpty).length;
  const trailingEmptyRowCount = countTrailingEmptyRows(sheet.rows);

  return {
    sheetName: sheet.sheetName,
    headers: sheet.headers,
    rowCount: sheet.rows.length,
    sampleRows: sheet.rows.slice(0, MAX_SAMPLE_ROWS),
    sampleRowsTruncated: sheet.rows.length > MAX_SAMPLE_ROWS,
    duplicateHeaders,
    emptyHeaderCount,
    emptyRowCount,
    trailingEmptyRowCount,
  };
}

export function previewImportFile(params: { filename: string; mimeType: string; buffer: Buffer }): ImportFilePreviewResult {
  const safety = checkImportFileSafety({ filename: params.filename, mimeType: params.mimeType, sizeBytes: params.buffer.byteLength, buffer: params.buffer });
  if (!safety.ok) return { ok: false, error: classifyImportReasonCode(safety.reasonCode, safety.message) };

  // includeBlankRows: true - this is the one caller that needs to SEE
  // blank/trailing rows (to report them), unlike every domain adapter's
  // own use of this parser.
  const parsed = parseWorkbookBuffer(params.buffer, { includeBlankRows: true });
  if (!parsed.ok) return { ok: false, error: classifyImportReasonCode(parsed.reasonCode, parsed.message) };

  const sheets = parsed.sheets.map(analyzeSheet);
  const warnings: string[] = [];
  for (const sheet of sheets) {
    if (sheet.duplicateHeaders.length > 0) warnings.push(`Sheet "${sheet.sheetName}" has duplicate column header(s): ${sheet.duplicateHeaders.join(", ")}.`);
    if (sheet.emptyHeaderCount > 0) warnings.push(`Sheet "${sheet.sheetName}" has ${sheet.emptyHeaderCount} blank column header(s), which will be ignored.`);
    if (sheet.trailingEmptyRowCount > 0) warnings.push(`Sheet "${sheet.sheetName}" has ${sheet.trailingEmptyRowCount} trailing blank row(s), which will be ignored.`);
    if (sheet.rowCount === 0) warnings.push(`Sheet "${sheet.sheetName}" has no data rows.`);
  }
  if (sheets.every((s) => s.rowCount === 0)) warnings.push("This file has no usable data rows in any sheet.");

  return { ok: true, sheets, totalRowCount: sheets.reduce((sum, s) => sum + s.rowCount, 0), warnings };
}
