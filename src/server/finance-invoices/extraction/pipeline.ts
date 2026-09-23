// Step 15C section 19/24: the whole Invoice extraction pipeline, orchestrating the pure pieces -
// PDF text (reused from Agreement extraction, domain-agnostic), field extraction, and
// classification. Local and deterministic: no OCR, no cloud call, exactly like Agreement
// extraction's own "parses one uploaded PDF (local, deterministic, no OCR, no cloud)" contract.
//
// FOUNDATION ONLY IN THIS STEP: nothing calls this from a route or a UI yet (see this package's
// `types.ts` header). It exists so the future Invoice Details step is built on the correct seam -
// this exact function, given the exact bytes a user uploads.

import { extractInvoiceFields } from "./field-extractors";
import { classifyInvoiceExtraction, manualReviewRequiredClassification } from "./extraction-result";
import { extractPdfText, MIN_EXTRACTABLE_CHARS } from "./pdf-text";
import type { InvoiceExtractedFieldProposal, InvoiceExtractionClassification, InvoiceExtractionWarning } from "./types";

export type InvoiceExtractionRunResult = {
  classification: InvoiceExtractionClassification;
  fields: InvoiceExtractedFieldProposal[];
  warnings: InvoiceExtractionWarning[];
};

export async function runInvoiceExtraction(bytes: Uint8Array): Promise<InvoiceExtractionRunResult> {
  const text = await extractPdfText(bytes);

  if (!text.ok) {
    const reason = text.reason === "no_extractable_text" ? "no_extractable_text" : "pdf_unreadable";
    return { classification: manualReviewRequiredClassification(reason), fields: [], warnings: [{ code: `pdf_${text.reason}` }] };
  }

  if (text.totalChars < MIN_EXTRACTABLE_CHARS) {
    // A scanned/blank document - never invent fields from near-nothing.
    return { classification: manualReviewRequiredClassification("no_extractable_text"), fields: [], warnings: [{ code: "pdf_no_extractable_text" }] };
  }

  const { fields, warnings } = extractInvoiceFields(text.pages);
  const lowConfidenceCore = fields.some((field) => (field.fieldKey === "externalInvoiceNumber" || field.fieldKey === "declaredTotalMinor") && field.confidence === "LOW");
  const classification = classifyInvoiceExtraction({ fields, truncated: text.truncated.chars, lowConfidenceCore });

  return { classification, fields, warnings };
}
