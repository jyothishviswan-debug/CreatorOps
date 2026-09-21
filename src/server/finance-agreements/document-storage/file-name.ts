import { createHash } from "node:crypto";

// Step 14B.1: pure naming / keying helpers shared by every adapter (real and fake), so a fake can never
// drift from what the real adapter stores.

const MAX_BASE_NAME_CHARS = 120;
const FALLBACK_BASE_NAME = "Agreement";

// idempotencyKey = sha256(agreementRef | version | artifactSha256), hex. One Agreement VERSION + one exact
// byte content = one key = one stored file.
export function agreementDocumentIdempotencyKey(agreementRef: string, version: number, artifactSha256: string): string {
  return createHash("sha256").update(`${agreementRef}|${version}|${artifactSha256}`).digest("hex");
}

export const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{64}$/;

// "<sanitized original base name> [<agreementRef> v<n>].pdf". Path separators and control / reserved
// characters are removed, whitespace collapsed, the original extension dropped and the length capped, so
// the stored name can never carry a path, a traversal or an unbounded string.
export function buildAgreementDocumentFileName(originalFileName: string, agreementRef: string, version: number): string {
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
  const safeRef = agreementRef.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  const safeVersion = Number.isInteger(version) && version > 0 ? version : 0;
  return `${cleaned.length > 0 ? cleaned : FALLBACK_BASE_NAME} [${safeRef} v${safeVersion}].pdf`;
}
