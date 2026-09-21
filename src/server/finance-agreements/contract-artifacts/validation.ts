import { createHash } from "node:crypto";

// Step 14A: PURE validation for an uploaded contract PDF. No parsing here (the
// extraction module owns that); this only decides whether the bytes are worth
// storing and handing to the parser at all.

export const MAX_CONTRACT_PDF_BYTES = 10 * 1024 * 1024;

// The PDF spec allows junk before the header, but only within the first 1024
// bytes (Acrobat's own rule). We require the magic inside that window.
export const PDF_MAGIC = "%PDF-";
export const PDF_HEADER_WINDOW_BYTES = 1024;

export const CONTRACT_PDF_MIME_TYPE = "application/pdf";

export type ContractPdfRejection = "empty" | "too_large" | "not_a_pdf" | "invalid_header";

export type ContractPdfValidation = { ok: true; sizeBytes: number } | { ok: false; reason: ContractPdfRejection };

const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

function findMagicOffset(bytes: Uint8Array): number {
  const limit = Math.min(bytes.length, PDF_HEADER_WINDOW_BYTES) - PDF_MAGIC_BYTES.length;
  for (let offset = 0; offset <= limit; offset++) {
    let matched = true;
    for (let i = 0; i < PDF_MAGIC_BYTES.length; i++) {
      if (bytes[offset + i] !== PDF_MAGIC_BYTES[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return offset;
  }
  return -1;
}

export function validateContractPdf(bytes: Uint8Array): ContractPdfValidation {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > MAX_CONTRACT_PDF_BYTES) return { ok: false, reason: "too_large" };

  const offset = findMagicOffset(bytes);
  if (offset < 0) return { ok: false, reason: "not_a_pdf" };

  // Header sanity: "%PDF-" must be followed by a "<major>.<minor>" version
  // (1.0 - 2.x). A stray "%PDF-" inside a text file is not a PDF.
  const versionStart = offset + PDF_MAGIC.length;
  const isDigit = (byte: number | undefined) => byte !== undefined && byte >= 0x30 && byte <= 0x39;
  const major = bytes[versionStart];
  const dot = bytes[versionStart + 1];
  const minor = bytes[versionStart + 2];
  if (!isDigit(major) || dot !== 0x2e || !isDigit(minor)) return { ok: false, reason: "invalid_header" };
  if (major! < 0x31 || major! > 0x32) return { ok: false, reason: "invalid_header" };

  return { ok: true, sizeBytes: bytes.length };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
