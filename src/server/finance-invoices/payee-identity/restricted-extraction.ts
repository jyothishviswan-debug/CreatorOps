import { extractPdfText, MIN_EXTRACTABLE_CHARS } from "../extraction/pdf-text";
import type { PayeeIdentityEvidence } from "./matcher";

// Step 16D section 5/6/7/8/9/13: server-only, RESTRICTED Invoice identity-EVIDENCE extraction over
// already-extracted PDF page text (reuses extraction/pdf-text.ts - the SAME local, deterministic,
// no-OCR parser the ordinary field-extractors.ts already uses; this is not a second PDF parser).
// Pure functions only - no Firestore, no network, no side effect - fully unit-tested in
// restricted-extraction.test.ts without a live server.
//
// SENSITIVE-DATA DISCIPLINE (section 5/17): every value this module proposes is a PROPOSAL ONLY -
// unconfirmed, source-backed (a page number; deliberately NO raw text snippet is kept anywhere in
// this module's own output shape, unlike the ordinary field-extractors.ts contract, specifically to
// shrink the sensitive-data surface a future log line or test snapshot could ever accidentally
// capture) and confidence-scored (HIGH/MEDIUM/LOW). Property names deliberately avoid the exact
// tokens finance-invoices-static.test.ts's FORBIDDEN_PROPERTY guard forbids anywhere in this module
// (gstin, gstNumber, accountNumber, bankAccountNumber, ifsc, accountHolderName, ...) - the same
// "taxRegistration"/"bankIdentifier" vocabulary payee-identity/types.ts already established.
//
// THE ONLY CALLER is resolve-identity.ts (via buildPayeeIdentityEvidence below), which folds these
// proposals into the existing Step 16C matcher's evidence shape and immediately discards the raw
// values once the safe PayeeIdentityMatchResult is built - nothing here is ever persisted to
// Firestore, returned from an API route, or logged.

export type RestrictedExtractionConfidence = "HIGH" | "MEDIUM" | "LOW";

export type RestrictedIdentityFieldEvidence = {
  value: string;
  confidence: RestrictedExtractionConfidence;
  page: number;
};

export type RestrictedPayeeIdentityEvidence = {
  taxRegistration: RestrictedIdentityFieldEvidence | null;
  businessAddress: RestrictedIdentityFieldEvidence | null;
  bankIdentifier: RestrictedIdentityFieldEvidence | null;
};

// --- Tax registration (GSTIN) - section 6 -----------------------------------------------------------------------------------
// Detects a value ONLY near one of these explicit labels - never a bare GSTIN-shaped string found
// in isolation elsewhere on the page (section 6: "do not infer GSTIN from unrelated alphanumeric
// strings"). The label itself carries no format assumption; the VALUE must additionally match the
// strict 15-character GSTIN shape (2 digits, 10 PAN-shaped, 1 entity code, literal "Z", 1 checksum
// character) - both signals (label AND format) are required together.
// NOTE: deliberately no trailing `\b` after the label alternation - several variants end in an
// OPTIONAL literal period ("No.", "GSTIN No.?"), and a zero-width \b immediately after a consumed
// "." would sit between two non-word characters (the "." and the ":"/space that follows) and could
// never match there. The `\s*[:\-]?\s*` suffix already prevents this from matching mid-word.
const TAX_REGISTRATION_LABEL = /\b(?:GSTIN|GST\s*No\.?|GST\s*Number|Supplier\s*GSTIN|Vendor\s*GSTIN|Tax\s*Registration(?:\s*(?:No\.?|Number))?)\s*[:\-]?\s*/gi;
const GSTIN_VALUE_PATTERN = /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z0-9]\b/g;
const TAX_REGISTRATION_WINDOW_CHARS = 100;
// Same-line-ish proximity: a value found within this many characters of the label is treated as an
// unambiguous "Label: VALUE" pairing (HIGH); further away in the window (e.g. on the next line) is
// still label-anchored but less certain (MEDIUM).
const SAME_LINE_PROXIMITY_CHARS = 20;

function extractTaxRegistration(pages: string[]): RestrictedIdentityFieldEvidence | null {
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex]!;
    TAX_REGISTRATION_LABEL.lastIndex = 0;
    const label = TAX_REGISTRATION_LABEL.exec(page);
    if (!label) continue;

    const windowStart = label.index + label[0].length;
    const window = page.slice(windowStart, windowStart + TAX_REGISTRATION_WINDOW_CHARS);
    const candidates = [...window.matchAll(GSTIN_VALUE_PATTERN)];
    if (candidates.length === 0) continue; // a label with no nearby valid-shaped value proposes nothing

    if (candidates.length > 1) {
      // Ambiguous: more than one GSTIN-shaped token near the same label - ammbiguity means this is
      // not reliable enough to ever participate in a hard comparison (section 13), but it is still
      // worth a human's attention.
      return { value: candidates[0]![0], confidence: "LOW", page: pageIndex + 1 };
    }

    const match = candidates[0]!;
    const confidence: RestrictedExtractionConfidence = match.index! < SAME_LINE_PROXIMITY_CHARS ? "HIGH" : "MEDIUM";
    return { value: match[0], confidence, page: pageIndex + 1 };
  }
  return null;
}

// --- Bank account evidence - section 8 --------------------------------------------------------------------------------------
// Same label+format discipline as tax registration: a bare digit run is never enough on its own
// (section 8: "do not infer bank data from arbitrary number sequences") - it must sit near one of
// these explicit labels. Deliberately scoped to the account-NUMBER only (never IFSC/holder name -
// the existing Step 16C matcher's evidence shape has exactly one bank-identifier comparison slot,
// mirroring canonical restricted.bank.accountNumber; adding IFSC/holder comparison would mean
// building a second matcher shape, which section 11 forbids).
// NOTE: no trailing `\b` for the same reason as TAX_REGISTRATION_LABEL above ("A/C No." ends in an
// optional period).
const BANK_LABEL = /\b(?:Beneficiary\s*Account(?:\s*Number)?|Bank\s*Account(?:\s*Number)?|Account\s*Number|A\/?C\.?\s*No\.?)\s*[:\-]?\s*/gi;
const BANK_VALUE_PATTERN = /\b\d{6,18}\b/g;
const BANK_WINDOW_CHARS = 60;

function extractBankIdentifier(pages: string[]): RestrictedIdentityFieldEvidence | null {
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex]!;
    BANK_LABEL.lastIndex = 0;
    const label = BANK_LABEL.exec(page);
    if (!label) continue;

    const windowStart = label.index + label[0].length;
    const window = page.slice(windowStart, windowStart + BANK_WINDOW_CHARS);
    const candidates = [...window.matchAll(BANK_VALUE_PATTERN)];
    if (candidates.length === 0) continue;

    if (candidates.length > 1) {
      return { value: candidates[0]![0], confidence: "LOW", page: pageIndex + 1 };
    }

    const match = candidates[0]!;
    const confidence: RestrictedExtractionConfidence = match.index! < SAME_LINE_PROXIMITY_CHARS ? "HIGH" : "MEDIUM";
    return { value: match[0], confidence, page: pageIndex + 1 };
  }
  return null;
}

// --- Business/payee address - section 7 -------------------------------------------------------------------------------------
// Anchored to the SAME supplier/vendor/payee label field-extractors.ts's own supplierNameField
// already uses - the address block is the non-blank lines that follow that label's own line (the
// label's own line is the supplier NAME, already handled by supplierNameField; this captures what
// comes after it). Stops at the first blank line or the first line that looks like it belongs to a
// DIFFERENT section (Bill To / Ship To / Customer / a bank block) - so a Bill-To customer address or
// a bank branch address can never be misattributed to the supplier (section 7).
const SUPPLIER_BLOCK_LABEL = /\b(?:From|Supplier|Vendor|Billed\s*By|Payee)\b\s*[:\-]?/gi;
// Stops the address block BEFORE a line that plainly belongs to a different section - a bill-to/
// ship-to customer block, a bank block, or a GST/tax-registration line (a real invoice often lists
// the address immediately followed by "GSTIN: ..." with no blank line in between).
const EXCLUDED_ADDRESS_LINE = /\b(?:Bill(?:ed)?\s*To|Ship\s*To|Customer|Branch|IFSC|Account\s*Number|A\/?C\.?\s*No|Beneficiary|GSTIN|GST\s*No|GST\s*Number|Tax\s*Registration)\b/i;
const MAX_ADDRESS_LINES = 4;
const MIN_ADDRESS_CHARS = 8;
const MAX_ADDRESS_CHARS = 400;

function extractBusinessAddress(pages: string[]): RestrictedIdentityFieldEvidence | null {
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex]!;
    SUPPLIER_BLOCK_LABEL.lastIndex = 0;
    const label = SUPPLIER_BLOCK_LABEL.exec(page);
    if (!label) continue;

    const firstLineEnd = page.indexOf("\n", label.index);
    if (firstLineEnd === -1) continue; // nothing follows the supplier's own line at all
    const rest = page.slice(firstLineEnd + 1);
    const lines = rest.split("\n");

    const collected: string[] = [];
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) break; // a blank line ends the supplier block
      if (EXCLUDED_ADDRESS_LINE.test(trimmed)) break; // a different section starts here - stop before it
      collected.push(trimmed);
      if (collected.length >= MAX_ADDRESS_LINES) break;
    }
    if (collected.length === 0) continue;

    const value = collected.join(", ");
    if (value.length < MIN_ADDRESS_CHARS || value.length > MAX_ADDRESS_CHARS) continue;

    const wordCount = collected[0]!.split(/\s+/).filter(Boolean).length;
    let confidence: RestrictedExtractionConfidence;
    if (collected.length >= 2) confidence = "HIGH";
    else if (wordCount >= 3) confidence = "MEDIUM";
    else confidence = "LOW"; // a single, thin line (e.g. just a city) is too weak to be confident

    return { value, confidence, page: pageIndex + 1 };
  }
  return null;
}

export function extractRestrictedPayeeIdentityEvidence(pages: string[]): RestrictedPayeeIdentityEvidence {
  return {
    taxRegistration: extractTaxRegistration(pages),
    businessAddress: extractBusinessAddress(pages),
    bankIdentifier: extractBankIdentifier(pages),
  };
}

// Runs the whole byte -> restricted-evidence path (section 9: text-bearing PDFs only, no OCR - a
// PDF with insufficient extractable text simply yields no evidence at all, which the matcher already
// treats as UNAVAILABLE/INSUFFICIENT_EVIDENCE, never a fabricated field). Never throws.
export async function extractRestrictedPayeeIdentityEvidenceFromBytes(bytes: Uint8Array): Promise<RestrictedPayeeIdentityEvidence | null> {
  const text = await extractPdfText(bytes);
  if (!text.ok) return null;
  if (text.totalChars < MIN_EXTRACTABLE_CHARS) return null;
  return extractRestrictedPayeeIdentityEvidence(text.pages);
}

// --- Confidence gate + evidence builder - section 13 -------------------------------------------------------------------------
// LOW-confidence evidence must never create an automatic hard mismatch on its own (section 13): the
// simplest, most conservative way to guarantee that is to never hand a LOW-confidence value to the
// matcher at all - it is withheld, so the corresponding field reports UNAVAILABLE (never MISMATCH,
// never a fabricated MATCH) exactly like "no evidence was ever extracted". HIGH/MEDIUM both
// participate in the existing Step 16C matcher's exact-only GST/bank comparison unchanged.
function usableValue(field: RestrictedIdentityFieldEvidence | null): string | null {
  if (!field) return null;
  return field.confidence === "LOW" ? null : field.value;
}

export type CanonicalPayeeIdentity = {
  expectedName: string | null;
  expectedTaxId: string | null;
  expectedAddress: string | null;
  expectedBankIdentifier: string | null;
};

// Pure - no Firestore - so the GST/bank/address matcher-integration behaviour (section 21) is fully
// testable without a live server. The ONLY place restricted values from extraction and canonical
// restricted values are folded into one PayeeIdentityEvidence for the existing, UNCHANGED Step 16C
// matcher (computePayeeIdentityMatch) - this function builds evidence, it never itself decides a
// verdict.
export function buildPayeeIdentityEvidence(canonical: CanonicalPayeeIdentity, extractedName: string | null, restricted: RestrictedPayeeIdentityEvidence | null): PayeeIdentityEvidence {
  return {
    expectedName: canonical.expectedName,
    extractedName,
    expectedTaxId: canonical.expectedTaxId,
    extractedTaxId: usableValue(restricted?.taxRegistration ?? null),
    expectedAddress: canonical.expectedAddress,
    extractedAddress: usableValue(restricted?.businessAddress ?? null),
    expectedBankIdentifier: canonical.expectedBankIdentifier,
    extractedBankIdentifier: usableValue(restricted?.bankIdentifier ?? null),
  };
}
