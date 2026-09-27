import * as XLSX from "xlsx";

import { MAX_IMPORT_CELL_CHARS, MAX_IMPORT_DECOMPRESSED_CHARS, MAX_IMPORT_ROWS_PER_BATCH, MAX_IMPORT_SHEETS_PER_FILE } from "@/server/imports/file-safety";
import type { RawSheetRow } from "./adapters/shared";

// Step 12A: the one shared spreadsheet-parsing boundary. Reads cell
// VALUES only - `cellFormula: false` means formula strings are never
// retained (XLSX.read itself never evaluates a formula; sheet_to_json
// below always reads each cell's own cached `.v` value, never a `.f`
// formula string) - and never makes any network request from a cell
// value found in the file (this module performs zero I/O of its own).
export type ParsedSheet = { sheetName: string; headers: string[]; rows: RawSheetRow[] };
export type ParseWorkbookResult = { ok: true; sheets: ParsedSheet[] } | { ok: false; reasonCode: string; message: string };

function readHeaders(worksheet: XLSX.WorkSheet): string[] {
  const ref = worksheet["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const headers: string[] = [];
  for (let col = range.s.c; col <= range.e.c; col++) {
    const cell = worksheet[XLSX.utils.encode_cell({ r: range.s.r, c: col })];
    const raw = cell?.v;
    if (raw === undefined || raw === null) continue;
    const text = String(raw).trim();
    if (text.length > 0) headers.push(text);
  }
  return headers;
}

export function parseWorkbookBuffer(buffer: Buffer, options: { includeBlankRows?: boolean } = {}): ParseWorkbookResult {
  let workbook: XLSX.WorkBook;
  try {
    // cellFormula: false - never retain/trust a cell's own formula text,
    // only its cached value. bookVBA: false is the library's own signal
    // that we never want VBA project data materialized even if present
    // (file-safety.ts's own byte-level scan is the primary rejection for
    // that - this is defense in depth, not a substitute for it).
    workbook = XLSX.read(buffer, { type: "buffer", cellFormula: false, bookVBA: false });
  } catch {
    return { ok: false, reasonCode: "UNREADABLE_WORKBOOK", message: "The file could not be read as a spreadsheet." };
  }

  const sheetNames = workbook.SheetNames ?? [];
  if (sheetNames.length === 0) {
    return { ok: false, reasonCode: "NO_SHEETS_FOUND", message: "The workbook has no sheets." };
  }
  if (sheetNames.length > MAX_IMPORT_SHEETS_PER_FILE) {
    return { ok: false, reasonCode: "TOO_MANY_SHEETS", message: `The workbook has ${sheetNames.length} sheets, exceeding the ${MAX_IMPORT_SHEETS_PER_FILE}-sheet import limit.` };
  }

  const sheets: ParsedSheet[] = [];
  let totalRows = 0;
  // Decompression-bomb defense (Import Center Completion, spec section
  // 14): a running total of every character read out of every cell in
  // the workbook, across every sheet - independent of row/sheet COUNT,
  // this is what actually catches a "few rows, gigantic cells" shape
  // that the row/sheet caps below would otherwise miss entirely.
  let decompressedChars = 0;

  for (const sheetName of sheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;

    const headers = readHeaders(worksheet);
    for (const header of headers) decompressedChars += header.length;

    // defval: null - a blank cell always becomes `null`, never coerced
    // to "" or `0`; raw: true - cell VALUES only, never formatted
    // display strings, and never a formula. blankrows defaults to false
    // (SheetJS's own default: a wholly-blank row is silently dropped),
    // which is exactly the behavior every existing caller (the Analytics
    // pipeline) already depends on; the Import Center Completion
    // File/Sheet Preview step (preview.ts) is the one caller that opts
    // into `includeBlankRows: true`, since detecting/reporting blank and
    // trailing rows is its own explicit job (spec section 3) and it
    // would otherwise never see them at all.
    const rows = XLSX.utils.sheet_to_json<RawSheetRow>(worksheet, { defval: null, raw: true, blankrows: options.includeBlankRows === true });

    for (const row of rows) {
      for (const key of Object.keys(row)) {
        const value = (row as Record<string, unknown>)[key];
        if (typeof value !== "string") continue;
        if (value.length > MAX_IMPORT_CELL_CHARS) {
          return { ok: false, reasonCode: "CELL_VALUE_TOO_LARGE", message: `A cell in sheet "${sheetName}" exceeds the ${MAX_IMPORT_CELL_CHARS.toLocaleString()}-character import limit.` };
        }
        decompressedChars += value.length;
        if (decompressedChars > MAX_IMPORT_DECOMPRESSED_CHARS) {
          return { ok: false, reasonCode: "DECOMPRESSION_LIMIT_EXCEEDED", message: "This file expands to far more data than the import limit allows (possible decompression bomb)." };
        }
      }
    }

    totalRows += rows.length;
    sheets.push({ sheetName, headers, rows });
  }

  if (totalRows > MAX_IMPORT_ROWS_PER_BATCH) {
    return { ok: false, reasonCode: "TOO_MANY_ROWS", message: `The file has ${totalRows} data rows, exceeding the ${MAX_IMPORT_ROWS_PER_BATCH}-row-per-batch import limit.` };
  }

  return { ok: true, sheets };
}
