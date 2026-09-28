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

// Import Center Completion (decompression-bomb / oversized-field defense -
// see AGENTS spec section 14): a workbook is a ZIP container, so its
// in-memory decompressed size can vastly exceed its on-disk (compressed)
// size. MAX_IMPORT_FILE_BYTES already bounds the COMPRESSED upload; these
// two additional limits bound what parsing is allowed to materialize -
// enforced in xlsx-parser.ts, which is the only place cell text is ever
// read out of a workbook.
//
// MAX_IMPORT_CELL_CHARS - a single cell's text is never trusted past this
// length (defends against one enormous string cell used to blow up
// memory/rendering/export without needing many rows at all).
export const MAX_IMPORT_CELL_CHARS = 20_000;
// MAX_IMPORT_DECOMPRESSED_CHARS - the running total of characters read out
// of EVERY cell in the workbook. A conservative absolute ceiling
// (independent of the row/sheet counts above, which only bound row/sheet
// COUNT, not per-cell payload size) - this is what actually stops a
// pathological "few rows, gigantic cells" decompression-bomb shape.
export const MAX_IMPORT_DECOMPRESSED_CHARS = 25_000_000; // ~25 MB of text

// Production hardening (base spec section 13 - "Import XLSX pre-parse resource defense"): every
// limit above is enforced DOWNSTREAM of `XLSX.read()` (in xlsx-parser.ts, per-cell, after the
// library has already fully unzipped and parsed the workbook into memory). A malicious .xlsx - a
// ZIP container - can still be a classic decompression bomb (a tiny compressed size, extreme
// compression ratio, expanding to a huge in-memory payload) that exhausts memory/CPU INSIDE
// `XLSX.read()` itself, before any of those downstream checks ever run. MAX_IMPORT_FILE_BYTES only
// bounds the COMPRESSED upload.
//
// These bound the ZIP container's own DECLARED structure - read straight out of the End Of Central
// Directory / central directory records (ZIP's own on-disk metadata), never by decompressing
// anything - so a hostile workbook is rejected before XLSX.read() is ever called on it, not after.
// Deliberately generous: a real 20-sheet (MAX_IMPORT_SHEETS_PER_FILE), 5000-row
// (MAX_IMPORT_ROWS_PER_BATCH) workbook has on the order of dozens of ZIP entries and, at typical
// DEFLATE ratios for XML/text (rarely more than 10-20:1), nowhere near these ceilings.
export const MAX_IMPORT_ZIP_ENTRIES = 200;
export const MAX_IMPORT_ZIP_ENTRY_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB, per ZIP entry
export const MAX_IMPORT_ZIP_TOTAL_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MB, across all entries
// A DEFLATE ratio beyond this is the actual "decompression bomb" signature - ordinary XML/text
// compresses at single- to low-double-digit ratios; a bomb payload (highly repetitive content
// engineered to compress extremely well) routinely exceeds 1000:1. 300:1 leaves real workbooks a
// wide margin while still catching the pathological case.
export const MAX_IMPORT_ZIP_COMPRESSION_RATIO = 300;

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

// ---- Pre-parse ZIP-container resource defense (base spec section 13) --------------------------
//
// A .xlsx file IS a ZIP container. Reads its own on-disk End Of Central Directory / central
// directory records - ZIP's own declared entry count and per-entry compressed/uncompressed sizes -
// WITHOUT decompressing a single byte, so a hostile workbook is rejected before `XLSX.read()` (which
// fully unzips and parses everything into memory) is ever called on it. Gated on the ZIP local-file
// signature so it is a genuine no-op for .xls (OLE2/CFB, a completely different binary format) and
// .csv (plain text) - the only container format this ever needs to police.
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIR_SIGNATURE = 0x02014b50;
const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_EOCD_MAX_COMMENT = 65535;
const ZIP32_SENTINEL = 0xffffffff;

function looksLikeZipContainer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === ZIP_LOCAL_FILE_SIGNATURE;
}

// The EOCD record sits at the end of the file, optionally followed by a variable-length comment
// (0-65535 bytes) - scanned backward from the end for its fixed signature.
function findEndOfCentralDirectory(buffer: Buffer): number | null {
  const minOffset = Math.max(0, buffer.length - ZIP_EOCD_MIN_SIZE - ZIP_EOCD_MAX_COMMENT);
  for (let i = buffer.length - ZIP_EOCD_MIN_SIZE; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) return i;
  }
  return null;
}

function malformedZipResult(): FileSafetyCheck {
  return { ok: false, reasonCode: "MALFORMED_ZIP_CONTAINER", message: "This file could not be read as a valid spreadsheet container." };
}

function preflightZipStructure(buffer: Buffer): FileSafetyCheck {
  if (!looksLikeZipContainer(buffer)) return { ok: true };

  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === null) return malformedZipResult();

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  // ZIP64 (needed only past 65535 entries or a 4 GB+ member/archive) is never legitimate for a
  // file already capped at MAX_IMPORT_FILE_BYTES - fail closed rather than parse an unsupported
  // extension format.
  if (totalEntries === 0xffff || centralDirSize === ZIP32_SENTINEL || centralDirOffset === ZIP32_SENTINEL) {
    return { ok: false, reasonCode: "UNSUPPORTED_ZIP64_CONTAINER", message: "This file uses an unsupported ZIP64 container format." };
  }
  if (totalEntries > MAX_IMPORT_ZIP_ENTRIES) {
    return { ok: false, reasonCode: "TOO_MANY_ZIP_ENTRIES", message: `This file's container has ${totalEntries} entries, exceeding the ${MAX_IMPORT_ZIP_ENTRIES}-entry import limit.` };
  }
  if (centralDirOffset + centralDirSize > buffer.length) return malformedZipResult();

  let offset = centralDirOffset;
  let totalUncompressed = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIR_SIGNATURE) return malformedZipResult();

    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);

    if (compressedSize === ZIP32_SENTINEL || uncompressedSize === ZIP32_SENTINEL) {
      return { ok: false, reasonCode: "UNSUPPORTED_ZIP64_CONTAINER", message: "This file uses an unsupported ZIP64 container format." };
    }
    if (uncompressedSize > MAX_IMPORT_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
      return { ok: false, reasonCode: "ZIP_ENTRY_TOO_LARGE", message: "This file's container has an entry that expands far beyond the import limit (possible decompression bomb)." };
    }
    // The actual decompression-bomb signature: a tiny compressed size claiming a much larger
    // uncompressed size. Guards the div-by-zero case (an entry that claims uncompressed bytes from
    // zero compressed bytes is itself the signature, not a legitimate empty/stored entry).
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > MAX_IMPORT_ZIP_COMPRESSION_RATIO)) {
      return { ok: false, reasonCode: "SUSPICIOUS_COMPRESSION_RATIO", message: "This file's container has an entry with a suspicious compression ratio (possible decompression bomb)." };
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_IMPORT_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      return { ok: false, reasonCode: "DECOMPRESSION_LIMIT_EXCEEDED", message: "This file expands to far more data than the import limit allows (possible decompression bomb)." };
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return { ok: true };
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

  // Production hardening (base spec section 13): rejects a ZIP-container decompression bomb from
  // its own declared structure, before XLSX.read() (which is what actually unzips it) ever runs.
  const zipCheck = preflightZipStructure(buffer);
  if (!zipCheck.ok) return zipCheck;

  return { ok: true };
}
