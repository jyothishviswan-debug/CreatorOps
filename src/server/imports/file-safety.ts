// Step 12A: the one shared file-size/extension/macro-rejection contract
// for the Import Center, reused by every target (today, only Analytics -
// see @/server/analytics/import-service.ts) rather than duplicated per
// target. Deliberately separate from Analytics' own module: a later
// second import target (Finance, Operations, whatever) reuses this file
// directly instead of re-deriving its own size caps.
//
// These are NEW, explicit limits for bulk import specifically - the only
// pre-existing size cap in the repo (MAX_UPLOAD_BYTES = 15MB, restricted-
// identity Drive uploads) is a completely different feature and is never
// reused or referenced here.
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_IMPORT_ROWS_PER_BATCH = 5000;
export const MAX_IMPORT_SHEETS_PER_FILE = 20;

// Accepted spreadsheet extensions/MIME types - deliberately narrow. Any
// macro-carrying workbook extension (.xlsm/.xlsb) is rejected outright at
// this level, before a single byte is parsed by the xlsx library.
const ACCEPTED_EXTENSIONS = new Set(["xlsx", "xls", "csv"]);
const REJECTED_MACRO_EXTENSIONS = new Set(["xlsm", "xlsb"]);

const ACCEPTED_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls (and, unfortunately, sometimes .csv from some exporters)
  "text/csv",
  "application/csv",
  "application/octet-stream", // some browsers/OSes report this generically - extension is still checked
]);

export type FileSafetyCheck = { ok: true } | { ok: false; reasonCode: string; message: string };

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "";
  return filename.slice(dot + 1).trim().toLowerCase();
}

// Byte-level heuristic macro-part scan: an .xlsx/.xlsm file is a ZIP
// container, and a macro-enabled workbook always carries a
// "vbaProject.bin" part somewhere in that ZIP's entry table. Rather than
// pull in a full ZIP-parsing dependency just for this one check, this
// scans the raw bytes for the ASCII literal - the local/central-directory
// file-name field in a ZIP is stored as plain bytes, so the literal
// filename always appears verbatim in the raw buffer regardless of
// compression of the part's own CONTENT. This is a deliberately
// conservative heuristic (a false positive only ever makes an import
// MORE cautious, never less) - it is not a substitute for the
// extension-level rejection above, which is the primary, load-bearing
// check; this is defense in depth against a mislabeled extension.
function containsVbaProjectPart(buffer: Buffer): boolean {
  return buffer.includes(Buffer.from("vbaProject.bin", "ascii"));
}

export function checkImportFileSafety(params: { filename: string; mimeType: string; sizeBytes: number; buffer: Buffer }): FileSafetyCheck {
  const { filename, mimeType, sizeBytes, buffer } = params;

  if (sizeBytes <= 0) {
    return { ok: false, reasonCode: "EMPTY_FILE", message: "The uploaded file is empty." };
  }
  if (sizeBytes > MAX_IMPORT_FILE_BYTES) {
    return { ok: false, reasonCode: "FILE_TOO_LARGE", message: `File exceeds the ${Math.round(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB import limit.` };
  }

  const extension = extensionOf(filename);
  if (REJECTED_MACRO_EXTENSIONS.has(extension)) {
    return { ok: false, reasonCode: "MACRO_WORKBOOK_REJECTED", message: "Macro-enabled workbooks (.xlsm/.xlsb) are not accepted for import." };
  }
  if (!ACCEPTED_EXTENSIONS.has(extension)) {
    return { ok: false, reasonCode: "UNSUPPORTED_EXTENSION", message: `Unsupported file extension ".${extension || "?"}". Accepted: .xlsx, .xls, .csv.` };
  }

  if (!ACCEPTED_MIME_TYPES.has(mimeType)) {
    return { ok: false, reasonCode: "UNSUPPORTED_MIME_TYPE", message: `Unsupported MIME type "${mimeType}".` };
  }

  if (containsVbaProjectPart(buffer)) {
    return { ok: false, reasonCode: "MACRO_CONTENT_DETECTED", message: "This file appears to contain macro (VBA) content and cannot be imported." };
  }

  return { ok: true };
}
