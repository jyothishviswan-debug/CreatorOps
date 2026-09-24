import type { PayeeIdentityConfidence, PayeeIdentityFieldStatus } from "./types";

// Step 16C section 7: PURE normalization + comparison helpers. Nothing here touches Firestore or
// any network - every function is a plain string -> string (or string,string -> result)
// transformation, unit-tested in normalization.test.ts without any server setup.
//
// Discipline shared by every comparator below (section 7/9/10):
//   - normalization is conservative (whitespace/case/punctuation/common-suffix only) - it never
//     merges two genuinely different legal identities;
//   - a tax ID or a bank identifier is NEVER fuzzy-matched - only exact-after-normalization;
//   - a similarity score (used only for the NAME field) is advisory evidence only - it can move an
//     ambiguous pair from a flat MISMATCH into REVIEW_REQUIRED, but it can never turn a genuine
//     mismatch into a MATCH, and it never applies to tax ID, address identity claims, or bank data.

export type FieldComparison = { status: PayeeIdentityFieldStatus; confidence: PayeeIdentityConfidence; reason: string | null };

function isBlank(value: string | null): value is null {
  return value === null || value.trim().length === 0;
}

// --- Name (section 7) --------------------------------------------------------------------------------------------------------------
// A closed, unambiguous list of common company/business suffixes - stripped only as a WHOLE
// trailing token (never mid-string), so "Private Limited Tours" never loses its "Limited". This
// never merges two different legal names; it only ignores a corporate-form suffix both names may or
// may not state.
const NAME_SUFFIXES = [
  "private limited",
  "pvt ltd",
  "pvt. ltd.",
  "pvt limited",
  "limited",
  "ltd",
  "llp",
  "llc",
  "inc",
  "incorporated",
  "corporation",
  "corp",
  "co",
  "company",
];

export function normalizeName(raw: string): string {
  let value = raw.normalize("NFKC").trim().toLocaleLowerCase();
  // Collapse whitespace (including line breaks) to single spaces.
  value = value.replace(/\s+/g, " ");
  // Remove safe punctuation only (never a character that could be part of the name's own script).
  value = value.replace(/[.,'"()/\\_-]+/g, " ").replace(/\s+/g, " ").trim();
  // Strip a trailing corporate-form suffix, at most once, matched as a whole final token sequence.
  for (const suffix of NAME_SUFFIXES) {
    const withSpace = ` ${suffix}`;
    if (value.endsWith(withSpace) && value.length > withSpace.length) {
      value = value.slice(0, value.length - withSpace.length).trim();
      break;
    }
  }
  return value;
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(" ").filter((token) => token.length > 0));
}

// Jaccard similarity over normalized word sets - a simple, dependency-free, EXPLAINABLE advisory
// signal (never the sole basis for a MATCH - section 7).
export function nameSimilarity(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Advisory band: high overlap but not identical is REVIEW_REQUIRED (a human should look), not an
// automatic pass and not an automatic hard mismatch. Below the low bound is a clear MISMATCH.
const NAME_REVIEW_SIMILARITY_MIN = 0.34;

export function compareNames(expected: string | null, extracted: string | null): FieldComparison {
  if (isBlank(expected) || isBlank(extracted)) {
    return { status: "UNAVAILABLE", confidence: "NONE", reason: "The canonical or extracted payee name is not available." };
  }
  if (expected.trim() === extracted.trim()) {
    return { status: "EXACT", confidence: "HIGH", reason: null };
  }
  const normalizedExpected = normalizeName(expected);
  const normalizedExtracted = normalizeName(extracted);
  if (normalizedExpected.length === 0 || normalizedExtracted.length === 0) {
    return { status: "UNAVAILABLE", confidence: "NONE", reason: "The canonical or extracted payee name is not available." };
  }
  if (normalizedExpected === normalizedExtracted) {
    return { status: "NORMALIZED_MATCH", confidence: "HIGH", reason: null };
  }
  const similarity = nameSimilarity(normalizedExpected, normalizedExtracted);
  if (similarity >= NAME_REVIEW_SIMILARITY_MIN) {
    return { status: "REVIEW_REQUIRED", confidence: "MEDIUM", reason: "The extracted payee name partially overlaps the expected counterparty name. A Finance reviewer should confirm." };
  }
  return { status: "MISMATCH", confidence: "HIGH", reason: "The extracted payee name does not match the expected counterparty name." };
}

// --- Tax registration identifier (section 7) - exact normalized comparison only, never fuzzy -----------------------------------------
export function normalizeTaxId(raw: string): string {
  return raw.normalize("NFKC").trim().toLocaleUpperCase().replace(/[\s-]+/g, "");
}

export function compareTaxIds(expected: string | null, extracted: string | null): FieldComparison {
  if (isBlank(expected) || isBlank(extracted)) {
    return { status: "UNAVAILABLE", confidence: "NONE", reason: "The canonical or extracted tax registration identifier is not available." };
  }
  const normalizedExpected = normalizeTaxId(expected);
  const normalizedExtracted = normalizeTaxId(extracted);
  if (normalizedExpected.length === 0 || normalizedExtracted.length === 0) {
    return { status: "UNAVAILABLE", confidence: "NONE", reason: "The canonical or extracted tax registration identifier is not available." };
  }
  if (normalizedExpected === normalizedExtracted) return { status: "EXACT", confidence: "HIGH", reason: null };
  return { status: "MISMATCH", confidence: "HIGH", reason: "The extracted tax registration identifier does not match the expected counterparty's registration." };
}

// --- Address (section 7) - conservative: never claims exact identity from a partial match -------------------------------------------
export function normalizeAddress(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\r\n]+/g, " ")
    .replace(/[.,#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ADDRESS_PARTIAL_TOKEN_MIN = 0.4;

export function compareAddresses(expected: string | null, extracted: string | null): FieldComparison {
  if (isBlank(expected) || isBlank(extracted)) {
    return { status: "UNAVAILABLE", confidence: "NONE", reason: "The canonical or extracted address is not available." };
  }
  const normalizedExpected = normalizeAddress(expected);
  const normalizedExtracted = normalizeAddress(extracted);
  if (normalizedExpected.length === 0 || normalizedExtracted.length === 0) {
    return { status: "UNAVAILABLE", confidence: "NONE", reason: "The canonical or extracted address is not available." };
  }
  if (normalizedExpected === normalizedExtracted) return { status: "NORMALIZED_MATCH", confidence: "HIGH", reason: null };
  const overlap = nameSimilarity(normalizedExpected, normalizedExtracted);
  if (overlap >= ADDRESS_PARTIAL_TOKEN_MIN) {
    // Deliberately never "EXACT"/"NORMALIZED_MATCH" here (section 7: "do not claim exact identity
    // merely because city/state matches") - only a full normalized equality above earns that.
    return { status: "REVIEW_REQUIRED", confidence: "LOW", reason: "The extracted address partially overlaps the expected counterparty address. A Finance reviewer should confirm." };
  }
  return { status: "MISMATCH", confidence: "MEDIUM", reason: "The extracted address does not resemble the expected counterparty address." };
}

// --- Bank identifier (section 7) - exact normalized comparison only, never fuzzy ------------------------------------------------------
export function normalizeBankIdentifier(raw: string): string {
  return raw.normalize("NFKC").trim().toLocaleUpperCase().replace(/[\s-]+/g, "");
}

export function compareBankIdentifiers(expected: string | null, extracted: string | null): FieldComparison {
  if (isBlank(expected) || isBlank(extracted)) {
    return { status: "UNAVAILABLE", confidence: "NONE", reason: "The canonical or extracted bank identifier is not available." };
  }
  const normalizedExpected = normalizeBankIdentifier(expected);
  const normalizedExtracted = normalizeBankIdentifier(extracted);
  if (normalizedExpected.length === 0 || normalizedExtracted.length === 0) {
    return { status: "UNAVAILABLE", confidence: "NONE", reason: "The canonical or extracted bank identifier is not available." };
  }
  if (normalizedExpected === normalizedExtracted) return { status: "EXACT", confidence: "HIGH", reason: null };
  return { status: "MISMATCH", confidence: "HIGH", reason: "The extracted bank identifier does not match the expected counterparty's bank identifier." };
}

// Masks a restricted bank identifier down to its last 4 characters (section 5/14: "optionally
// masked last 4 digits if already permitted"). Never returns anything else derived from the raw
// value - callers must never pass this the extracted/expected value for any OTHER purpose.
export function maskBankIdentifierLast4(raw: string | null): string | null {
  if (isBlank(raw)) return null;
  const normalized = normalizeBankIdentifier(raw);
  if (normalized.length === 0) return null;
  const last4 = normalized.slice(-4);
  return `•••• ${last4}`;
}
