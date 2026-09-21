import { AGREEMENT_FIELD_BY_KEY, type AgreementFieldKey } from "@/server/finance-agreements/fields";

import { NO_VALUE_TEXT } from "./format";

// Step 14B: the ONE masking rule for identity values in the browser (step doc section 20: never render an unrestricted PAN, Aadhaar,
// GSTIN, bank account number or IFSC). It applies to EVERY actor, including one who holds the identity category: such an actor may
// COMPARE and acknowledge a value, but the page only ever shows its last four characters, e.g. `••••••321Z`. An actor without access
// never gets a value at all (the DTO says RESTRICTED and the UI prints "Restricted" - that path never reaches this module).
// Pure and unit-tested. The API responses are a separate, backend concern.
export const MASK_CHARACTER = "•";
export const IDENTITY_VISIBLE_TAIL = 4;

export function isIdentityField(fieldKey: AgreementFieldKey): boolean {
  return AGREEMENT_FIELD_BY_KEY[fieldKey].identityValue;
}

// Everything but the last four characters becomes a bullet (whitespace inside a number is dropped first: "2341 2341 2346" is one
// value). A value of four characters or fewer is masked completely - nothing of a short value is worth showing.
export function maskTail(raw: string): string {
  const compact = raw.replace(/\s+/g, "");
  if (compact.length <= IDENTITY_VISIBLE_TAIL) return MASK_CHARACTER.repeat(compact.length);
  return MASK_CHARACTER.repeat(compact.length - IDENTITY_VISIBLE_TAIL) + compact.slice(-IDENTITY_VISIBLE_TAIL);
}

// A field's value as the page may show it: an identity field is masked; any other field's value is returned as text unchanged.
// null / undefined / blank read as "no value".
export function maskIdentityValue(fieldKey: AgreementFieldKey, value: unknown): string {
  if (value === null || value === undefined) return NO_VALUE_TEXT;
  const text = Array.isArray(value) ? value.map(String).join(", ") : String(value);
  if (text.trim().length === 0) return NO_VALUE_TEXT;
  if (!isIdentityField(fieldKey)) return text;
  return Array.isArray(value) ? value.map((item) => maskTail(String(item))).join(", ") : maskTail(text);
}

// Free text (a raw contract snippet, which only an actor with contract access may see) can carry an identity number. Every identity-shaped
// token in it is masked the same way: GSTIN, PAN, IFSC, Aadhaar (12 digits, optionally spaced), account numbers (9-18 digits) and - because a
// snippet is a window that can cut a number short - any other token of 8+ letters/digits that contains four or more digits.
const IDENTITY_PATTERNS: readonly RegExp[] = [
  /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g, // GSTIN
  /\b[A-Z]{5}\d{4}[A-Z]\b/g, // PAN
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, // IFSC
  /\b\d{4}[ \t]?\d{4}[ \t]?\d{4}\b/g, // Aadhaar
  /\b\d{9,18}\b/g, // bank account
];
const LONG_TOKEN = /\b[A-Za-z0-9]{8,}\b/g;

export function maskIdentityInText(text: string): string {
  let out = text;
  for (const pattern of IDENTITY_PATTERNS) out = out.replace(pattern, (match) => maskTail(match));
  return out.replace(LONG_TOKEN, (token) => ((token.match(/\d/g) ?? []).length >= 4 ? maskTail(token) : token));
}
