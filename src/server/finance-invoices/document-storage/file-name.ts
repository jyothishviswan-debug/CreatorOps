// Step 16E: pure naming / keying helpers for the Invoice document-storage port, mirroring Agreements'
// own document-storage/file-name.ts exactly (same discipline: a small, dependency-free module so the
// real adapter and any future adapter can never drift from what a test expects).

export const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{64}$/;

const MAX_BASE_NAME_CHARS = 120;
const FALLBACK_BASE_NAME = "Invoice";

// "<sanitized original base name> [<invoiceRef> v<n>].pdf". Path separators and control / reserved
// characters are removed, whitespace collapsed, the original extension dropped and the length capped,
// so the stored name can never carry a path, a traversal or an unbounded string. No restricted value
// (bank/GST/address) is ever representable here - only the caller-supplied original file name and the
// already-public invoiceRef/version.
export function buildInvoiceDocumentFileName(originalFileName: string, invoiceRef: string, version: number): string {
  const lastSegment = originalFileName.split(/[\\/]/).pop() ?? "";
  const withoutExtension = lastSegment.replace(/\.pdf$/i, "");
  const cleaned = withoutExtension
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ._()&,'+-]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, MAX_BASE_NAME_CHARS)
    .trim();
  const safeRef = invoiceRef.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  const safeVersion = Number.isInteger(version) && version > 0 ? version : 0;
  return `${cleaned.length > 0 ? cleaned : FALLBACK_BASE_NAME} [${safeRef} v${safeVersion}].pdf`;
}
