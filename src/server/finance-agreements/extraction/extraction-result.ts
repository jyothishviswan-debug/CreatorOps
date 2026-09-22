import type { ExtractedFieldKey, ExtractedFieldProposal, ExtractionConfidence, ExtractionWarning } from "./extraction-types";
import type { PdfTextFailureReason, PdfTextResult } from "./pdf-text";

// Step 14A: classification of an extraction run, and the ordinary/restricted
// split of its proposals.
//
// STATUS MEANS EXTRACTION COMPLETENESS ONLY. EXTRACTED does not mean "verified",
// "correct" or "legally valid" - every proposal, whatever the status, still needs
// a human decision (requiresHumanConfirmation is always true) and nothing becomes
// operational until confirmed. The status only tells the reviewer how much of the
// form the parser could pre-fill.

export const EXTRACTION_STATUSES = ["EXTRACTED", "PARTIAL", "MANUAL_REVIEW_REQUIRED"] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export type ExtractionReasonCode =
  | PdfTextFailureReason
  | "few_fields"
  | "missing_core_fields"
  | "ambiguous_core_field"
  | "text_truncated"
  | "extractor_rule_error";

// The REQUIRED CORE set: what a usable agreement pre-fill needs.
//   - counterpartyName and effectiveDate, both required to confirm an agreement;
//   - at least ONE commercial-structure field (fixed fee, required content count or
//     incentive) - without one nothing about the deal was read;
//   - a currency whenever any amount was extracted (an amount without a currency
//     cannot be confirmed).
export const CORE_REQUIRED_FIELDS = ["counterpartyName", "effectiveDate"] as const satisfies readonly ExtractedFieldKey[];
export const CORE_COMMERCIAL_ANY_OF = ["fixedComponent", "monthlyRequiredQualifyingContentCount", "incentive"] as const satisfies readonly ExtractedFieldKey[];

// Below this many proposals the run is too thin to be a pre-fill at all.
export const MIN_FIELDS_FOR_PARTIAL = 3;

export type ExtractionClassification = {
  status: ExtractionStatus;
  reasons: ExtractionReasonCode[];
  // Which core requirements were not met (field keys, or "commercial_structure").
  missingCore: string[];
  fieldCount: number;
};

function hasAmount(fields: readonly ExtractedFieldProposal[]): boolean {
  return fields.some((field) => {
    if (field.fieldKey === "fixedComponent" || field.fieldKey === "accountTransferFee" || field.fieldKey === "advancePayment") return field.normalizedValue.amountMinor !== null;
    if (field.fieldKey === "incentive") return field.normalizedValue.slabs.length > 0;
    return false;
  });
}

// A field counts toward the commercial-structure core requirement only when it actually found something. The
// incentive rule may propose a LOW-confidence {applicable:false} "no incentive language found" SUGGESTION for a
// document that says nothing about incentives at all (see incentive-target-rules.ts) - that suggestion is not
// evidence of a commercial structure, so it must never by itself satisfy this requirement.
function satisfiesCommercialCore(field: ExtractedFieldProposal | undefined): boolean {
  if (!field) return false;
  if (field.fieldKey === "incentive") return field.normalizedValue.applicable;
  return true;
}

export function classifyExtraction(pdfResult: PdfTextResult, fields: readonly ExtractedFieldProposal[], warnings: readonly ExtractionWarning[] = []): ExtractionClassification {
  // A PDF that could not be read yields NO usable proposals, whatever `fields` holds:
  // never partial garbage from a failed parse.
  if (!pdfResult.ok) return { status: "MANUAL_REVIEW_REQUIRED", reasons: [pdfResult.reason], missingCore: [], fieldCount: 0 };

  const reasons: ExtractionReasonCode[] = [];
  const present = new Map(fields.map((field) => [field.fieldKey, field]));
  const missingCore: string[] = [];

  for (const key of CORE_REQUIRED_FIELDS) if (!present.has(key)) missingCore.push(key);
  if (!CORE_COMMERCIAL_ANY_OF.some((key) => satisfiesCommercialCore(present.get(key)))) missingCore.push("commercial_structure");
  if (hasAmount(fields) && !present.has("currency")) missingCore.push("currency");

  if (fields.length < MIN_FIELDS_FOR_PARTIAL) {
    reasons.push("few_fields");
    if (missingCore.length > 0) reasons.push("missing_core_fields");
    return { status: "MANUAL_REVIEW_REQUIRED", reasons, missingCore, fieldCount: fields.length };
  }

  let status: ExtractionStatus = "EXTRACTED";
  if (missingCore.length > 0) {
    reasons.push("missing_core_fields");
    status = "PARTIAL";
  }
  const lowConfidenceCore = CORE_REQUIRED_FIELDS.some((key) => present.get(key)?.confidence === "LOW");
  if (lowConfidenceCore) {
    reasons.push("ambiguous_core_field");
    status = "PARTIAL";
  }
  if (pdfResult.truncated.chars) {
    reasons.push("text_truncated");
    status = "PARTIAL";
  }
  if (warnings.some((warning) => warning.code.startsWith("rule_error:"))) {
    reasons.push("extractor_rule_error");
    status = "PARTIAL";
  }
  return { status, reasons, missingCore, fieldCount: fields.length };
}

// --- Ordinary / restricted split -----------------------------------------------------------------------

// An ordinary (non-restricted) proposal: NO rawSnippet, NO locator. For an identity
// field `normalizedValue` is absent - only the fact that it was detected (and how
// confidently) is ordinary information.
export type OrdinaryProposal = {
  fieldKey: ExtractedFieldKey;
  normalizedValue?: ExtractedFieldProposal["normalizedValue"];
  page: number;
  confidence: ExtractionConfidence;
  warnings: string[];
  requiresHumanConfirmation: true;
  restricted: boolean;
};

// Everything that may only live in the restricted extraction record.
export type RestrictedExtractionParts = {
  // The raw snippet of EVERY proposal (a snippet can quote an identity value).
  rawSnippets: Array<{ fieldKey: ExtractedFieldKey; page: number; rawSnippet: string }>;
  // Identity values (PAN, PAN holder name, Aadhaar, bank account, IFSC, GSTIN).
  identityValues: Array<{ fieldKey: ExtractedFieldKey; normalizedValue: string }>;
};

export type SplitExtraction = { ordinary: OrdinaryProposal[]; restricted: RestrictedExtractionParts };

const MIN_LEAK_CHECK_LENGTH = 6;

export function splitRestricted(fields: readonly ExtractedFieldProposal[]): SplitExtraction {
  const restricted: RestrictedExtractionParts = { rawSnippets: [], identityValues: [] };
  for (const field of fields) {
    restricted.rawSnippets.push({ fieldKey: field.fieldKey, page: field.page, rawSnippet: field.rawSnippet });
    if (field.restricted) restricted.identityValues.push({ fieldKey: field.fieldKey, normalizedValue: String(field.normalizedValue) });
  }

  // Defence in depth: an ORDINARY value must never quote an identity value (an
  // address or clause that swallowed a PAN, say). If one does, the value is
  // withheld from the ordinary record and the proposal keeps only its metadata.
  // The PAN HOLDER NAME is a name, not an identifier: it legitimately overlaps the ordinary counterparty name / page name
  // ("Sample Creator" inside "Sample Creator Studio"), so only ID-shaped values (PAN, Aadhaar, GSTIN, account, IFSC) are checked.
  const secrets = restricted.identityValues
    .filter((entry) => entry.fieldKey !== "panHolderName")
    .map((entry) => entry.normalizedValue.toLowerCase())
    .filter((value) => value.length >= MIN_LEAK_CHECK_LENGTH);

  const ordinary: OrdinaryProposal[] = fields.map((field) => {
    const base = { fieldKey: field.fieldKey, page: field.page, confidence: field.confidence, warnings: [...field.warnings], requiresHumanConfirmation: true as const, restricted: field.restricted };
    if (field.restricted) return base;
    const serialized = JSON.stringify(field.normalizedValue).toLowerCase();
    if (secrets.some((secret) => serialized.includes(secret))) return { ...base, warnings: [...base.warnings, "value_withheld_contains_restricted_data"] };
    return { ...base, normalizedValue: field.normalizedValue };
  });

  return { ordinary, restricted };
}
