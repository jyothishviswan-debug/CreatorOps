// Step 15C section 19/24: the whole Invoice extraction pipeline, orchestrating the pure pieces -
// PDF text (reused from Agreement extraction, domain-agnostic), field extraction, and
// classification. Local and deterministic: no cloud call, exactly like Agreement extraction's own
// contract.
//
// OCR Completion stage: OCR is now a FALLBACK, invoked only when native text is insufficient (see
// runOcrFallback below) - text-bearing PDFs are completely unaffected, and OCR output feeds the
// SAME extractInvoiceFields() rules used for native text (no parallel/duplicate parser).

import { extractInvoiceFields } from "./field-extractors";
import { classifyInvoiceExtraction, manualReviewRequiredClassification } from "./extraction-result";
import type { OcrConfidenceBand, OcrFailureReason } from "./ocr-provider";
import { extractPdfText, MIN_EXTRACTABLE_CHARS } from "./pdf-text";
import type { InvoiceExtractedFieldProposal, InvoiceExtractionClassification, InvoiceExtractionConfidence, InvoiceExtractionReasonCode, InvoiceExtractionSource, InvoiceExtractionWarning } from "./types";

export type InvoiceExtractionRunResult = {
  classification: InvoiceExtractionClassification;
  fields: InvoiceExtractedFieldProposal[];
  warnings: InvoiceExtractionWarning[];
  source: InvoiceExtractionSource;
};

// Injected by the caller (extraction-preview-service.ts) so this file stays free of any
// persistence/runtime OCR-engine dependency at import time - a caller that omits it gets EXACTLY
// today's native-only behavior.
export type OcrPageInfo = { confidence: number; band: OcrConfidenceBand };
export type OcrRunOutcome =
  | { ok: true; pages: string[]; pageInfo: Map<number, OcrPageInfo>; providerId: string; providerVersion: string; configVersion: string }
  | { ok: false; reason: OcrFailureReason };
export type OcrRunner = (bytes: Uint8Array, artifactSha256: string) => Promise<OcrRunOutcome>;

const NATIVE_SOURCE: InvoiceExtractionSource = { kind: "native" };

function ocrFailureToInvoiceReason(reason: OcrFailureReason): InvoiceExtractionReasonCode {
  switch (reason) {
    case "no_usable_text":
      return "ocr_no_usable_text";
    case "too_many_pages":
      return "ocr_too_many_pages";
    case "timeout":
      return "ocr_timeout";
    case "encrypted":
      return "ocr_encrypted";
    case "rasterization_failed":
      return "ocr_rasterization_failed";
    case "image_too_large":
      return "ocr_image_too_large";
    default:
      return "ocr_unreadable_pdf";
  }
}

// OCR-sourced fields are categorically lower trust than a clean native PDF text layer, even at high
// OCR engine confidence (spec section 9): never HIGH, and capped at LOW for a page whose OCR
// confidence band was not USABLE.
const CONFIDENCE_RANK: Record<InvoiceExtractionConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
function capFieldsForOcr(fields: InvoiceExtractedFieldProposal[], pageInfo: Map<number, OcrPageInfo>): InvoiceExtractedFieldProposal[] {
  return fields.map((field) => {
    const band = pageInfo.get(field.page)?.band ?? "LOW";
    const cap: InvoiceExtractionConfidence = band === "USABLE" ? "MEDIUM" : "LOW";
    const confidence: InvoiceExtractionConfidence = CONFIDENCE_RANK[field.confidence] > CONFIDENCE_RANK[cap] ? cap : field.confidence;
    return confidence === field.confidence ? field : { ...field, confidence };
  });
}

export async function runInvoiceExtraction(bytes: Uint8Array, ocrRunner?: OcrRunner, artifactSha256?: string): Promise<InvoiceExtractionRunResult> {
  const text = await extractPdfText(bytes);
  const insufficientNative = !text.ok ? text.reason === "no_extractable_text" : text.totalChars < MIN_EXTRACTABLE_CHARS;

  if (insufficientNative && ocrRunner && artifactSha256) {
    const ocr = await ocrRunner(bytes, artifactSha256).catch((): OcrRunOutcome => ({ ok: false, reason: "unreadable_pdf" }));
    if (!ocr.ok) {
      return { classification: manualReviewRequiredClassification(ocrFailureToInvoiceReason(ocr.reason)), fields: [], warnings: [{ code: `ocr_${ocr.reason}` }], source: { kind: "ocr" } };
    }
    const source: InvoiceExtractionSource = {
      kind: "ocr",
      ocrProviderId: ocr.providerId,
      ocrProviderVersion: ocr.providerVersion,
      ocrConfigVersion: ocr.configVersion,
      ocrPages: [...ocr.pageInfo.entries()].map(([page, info]) => ({ page, confidence: info.confidence, band: info.band })),
    };
    const { fields: rawFields, warnings } = extractInvoiceFields(ocr.pages);
    const fields = capFieldsForOcr(rawFields, ocr.pageInfo);
    const lowConfidenceCore = fields.some((field) => (field.fieldKey === "externalInvoiceNumber" || field.fieldKey === "declaredTotalMinor") && field.confidence === "LOW");
    const classified = classifyInvoiceExtraction({ fields, truncated: false, lowConfidenceCore });
    const classification: InvoiceExtractionClassification = { ...classified, reasons: ["ocr_used", ...classified.reasons] };
    return { classification, fields, warnings, source };
  }

  if (!text.ok) {
    const reason = text.reason === "no_extractable_text" ? "no_extractable_text" : "pdf_unreadable";
    return { classification: manualReviewRequiredClassification(reason), fields: [], warnings: [{ code: `pdf_${text.reason}` }], source: NATIVE_SOURCE };
  }

  if (text.totalChars < MIN_EXTRACTABLE_CHARS) {
    // A scanned/blank document with no ocrRunner injected - never invent fields from near-nothing.
    return { classification: manualReviewRequiredClassification("no_extractable_text"), fields: [], warnings: [{ code: "pdf_no_extractable_text" }], source: NATIVE_SOURCE };
  }

  const { fields, warnings } = extractInvoiceFields(text.pages);
  const lowConfidenceCore = fields.some((field) => (field.fieldKey === "externalInvoiceNumber" || field.fieldKey === "declaredTotalMinor") && field.confidence === "LOW");
  const classification = classifyInvoiceExtraction({ fields, truncated: text.truncated.chars, lowConfidenceCore });

  return { classification, fields, warnings, source: NATIVE_SOURCE };
}
