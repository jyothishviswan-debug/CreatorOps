// Step 14A: human-readable text for the stable machine reason codes of an extraction run.
// Codes are what is stored; the message is derived at read time (never contains contract text
// or any value). Status means extraction COMPLETENESS only - never legal verification.

export const EXTRACTION_REASON_ARTIFACT_INTEGRITY = "artifact_integrity_mismatch";
export const EXTRACTION_REASON_PROPOSAL_DROPPED = "proposal_dropped_invalid";

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  // OCR Completion stage: no_extractable_text on its own now only means OCR itself never ran (an
  // internal/test condition) - the ocr_* codes below describe what OCR did after it ran.
  no_extractable_text: "No readable text was found in the PDF, and it could not be read automatically. Enter the terms manually.",
  unreadable_pdf: "The PDF could not be read. Enter the terms manually.",
  encrypted: "The PDF is password-protected and cannot be read. Enter the terms manually.",
  too_many_pages: "The PDF has more pages than can be read automatically. Enter the terms manually.",
  timeout: "Reading the PDF took too long. Enter the terms manually.",
  few_fields: "Too few fields could be identified to pre-fill the agreement.",
  missing_core_fields: "Some core fields (counterparty name, effective date or commercial structure) were not found.",
  ambiguous_core_field: "A core field was found with low confidence.",
  text_truncated: "The contract text was longer than the reader's limit and was truncated.",
  extractor_rule_error: "One or more extraction rules failed; the pre-fill may be incomplete.",
  [EXTRACTION_REASON_ARTIFACT_INTEGRITY]: "The stored contract file does not match its recorded checksum.",
  [EXTRACTION_REASON_PROPOSAL_DROPPED]: "Some proposals could not be stored and were left out.",
  // Scanned document detected -> OCR was used to read it (spec section 20/22 UI copy).
  ocr_used: "Scanned document detected. OCR was used to read it - review the extracted fields carefully.",
  ocr_no_usable_text: "We couldn't reliably read this scanned document. You can continue with manual review.",
  ocr_too_many_pages: "The scanned document has more pages than can be read automatically. Enter the terms manually.",
  ocr_timeout: "Reading the scanned document took too long. You can continue with manual review.",
  ocr_encrypted: "The scanned document is password-protected and cannot be read. Enter the terms manually.",
  ocr_unreadable_pdf: "The scanned document could not be read. You can continue with manual review.",
  ocr_rasterization_failed: "The scanned document's pages could not be prepared for reading. You can continue with manual review.",
  ocr_image_too_large: "One or more pages of the scanned document are too large to read automatically. You can continue with manual review.",
};

export function describeExtractionReason(code: string): string {
  if (REASON_MESSAGES[code]) return REASON_MESSAGES[code]!;
  if (code.startsWith("missing_core:")) return "A required core field was not found in the contract.";
  return "See the extraction status.";
}
