// Step 14A: view-time redaction of RAW contract snippets.
//
// A raw snippet is up to ~300 characters "around the match" of an extracted field, so a snippet
// taken for an ordinary field (an address, a clause) can sit next to - or quote - an identity
// value (PAN, Aadhaar, GSTIN, bank account, IFSC, PAN holder name). An actor who may read raw
// contract detail (finance_contracts) but does NOT hold the owning identity category must never
// see those values through a snippet either. Two layers, both applied by the caller before a
// snippet is placed in a DTO:
//   1. every identity value the run actually extracted is masked (separator-tolerant, so
//      "2341 2341 2346" is caught when the run stored "234123412346");
//   2. every string that merely LOOKS like an identity value (format-anchored) is masked, so a
//      value the extractor did not itself extract is masked too.
// Pure: no I/O.

export const RESTRICTED_PLACEHOLDER = "[restricted]";

// Identity values shorter than this are not masked by exact match (too likely to be a common word).
const MIN_EXACT_MASK_LENGTH = 6;

// GSTIN first (it embeds a PAN), then PAN, IFSC, grouped/plain Aadhaar, any long digit run.
const IDENTITY_SHAPES: readonly RegExp[] = [
  /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi,
  /\b[A-Z]{5}\d{4}[A-Z]\b/gi,
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi,
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g,
  /\d{9,}/g,
];

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactValuePattern(value: string): RegExp | null {
  const trimmed = value.trim();
  if (trimmed.length < MIN_EXACT_MASK_LENGTH) return null;
  const isDigits = /^\d+$/.test(trimmed);
  const source = [...trimmed]
    .map((char) => (char === " " ? "\\s+" : escapeRegex(char)))
    .join(isDigits ? "[ -]?" : "");
  return new RegExp(source, "gi");
}

export function redactIdentityFromText(text: string, identityValues: readonly string[]): string {
  let out = text;
  // Longest first, so a value that contains another is masked as a whole.
  const ordered = [...identityValues].sort((a, b) => b.length - a.length);
  for (const value of ordered) {
    const pattern = exactValuePattern(value);
    if (pattern) out = out.replace(pattern, RESTRICTED_PLACEHOLDER);
  }
  for (const shape of IDENTITY_SHAPES) out = out.replace(shape, RESTRICTED_PLACEHOLDER);
  return out;
}
