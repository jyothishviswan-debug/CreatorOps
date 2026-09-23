// Step 15C section 19/24: extraction-completeness classification. STATUS MEANS EXTRACTION
// COMPLETENESS ONLY - nothing here confirms a value or writes an Invoice; that is a separate,
// explicit user action (not built in this step - see this module's own header comment in
// extraction/types.ts). Mirrors Agreement extraction's classifyExtraction discipline.

import { INVOICE_CORE_REQUIRED_FIELDS, type InvoiceExtractedFieldKey, type InvoiceExtractedFieldProposal, type InvoiceExtractionClassification, type InvoiceExtractionReasonCode } from "./types";

export function classifyInvoiceExtraction(input: { fields: InvoiceExtractedFieldProposal[]; truncated: boolean; lowConfidenceCore: boolean }): InvoiceExtractionClassification {
  const present = new Set(input.fields.map((field) => field.fieldKey));
  const missingCore: InvoiceExtractedFieldKey[] = INVOICE_CORE_REQUIRED_FIELDS.filter((key) => !present.has(key));
  const reasons: InvoiceExtractionReasonCode[] = [];
  if (missingCore.length > 0) reasons.push("missing_core_fields");
  if (input.truncated) reasons.push("truncated");
  if (input.lowConfidenceCore) reasons.push("low_confidence_core");

  const status = missingCore.length === INVOICE_CORE_REQUIRED_FIELDS.length ? "MANUAL_REVIEW_REQUIRED" : missingCore.length > 0 || reasons.length > 0 ? "PARTIAL" : "EXTRACTED";

  return { status, reasons, missingCore, fieldCount: input.fields.length };
}

// A PDF that produced no readable text at all (scanned/blank/encrypted/unreadable) - never a
// partial classification, always straight to manual review, and never an invented field.
export function manualReviewRequiredClassification(reason: InvoiceExtractionReasonCode): InvoiceExtractionClassification {
  return { status: "MANUAL_REVIEW_REQUIRED", reasons: [reason], missingCore: [...INVOICE_CORE_REQUIRED_FIELDS], fieldCount: 0 };
}
