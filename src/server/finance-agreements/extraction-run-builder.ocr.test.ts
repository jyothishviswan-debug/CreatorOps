import { describe, expect, it, vi } from "vitest";

import { sha256Hex } from "./contract-artifacts/validation";
import type { OcrExtractionOutcome } from "./extraction-ocr";
import { runExtractionPipeline, type OcrRunner } from "./extraction-run-builder";
import { makeBlankPdf, makeEncryptedPdf, makeTextPdf } from "./testing/pdf-fixtures";

// OCR Completion stage: pipeline-shape tests with an INJECTED fake OcrRunner (no real Firestore, no
// real Tesseract - this file is about the wiring/decision logic, not the OCR engine itself; the
// engine's own real end-to-end behavior is covered separately in extraction/ocr-provider.test.ts).

type OkOcrOutcome = Extract<OcrExtractionOutcome, { ok: true }>;
const OK_OCR_OUTCOME = (pages: string[]): OkOcrOutcome => ({
  ok: true,
  pdf: { ok: true, pages, pageCount: pages.length, totalChars: pages.join("").length, truncated: { chars: false } },
  pageInfo: new Map(pages.map((_, index) => [index + 1, { confidence: 92, band: "USABLE" as const }])),
  providerId: "tesseract.js",
  providerVersion: "7.0.0+eng-4.0.0_best_int",
  configVersion: "raster-2.0x-v1",
  warnings: [],
});

describe("runExtractionPipeline - OCR fallback decision (spec section 2)", () => {
  it("does NOT invoke the OCR runner for a normal text-bearing PDF (native text is usable)", async () => {
    const bytes = makeTextPdf([["Counterparty: Sample Creator Studio", "Effective Date: 2025-01-01", "Fixed monthly fee: Rs. 20000"]]);
    const ocrRunner = vi.fn<OcrRunner>();
    const outcome = await runExtractionPipeline(bytes, sha256Hex(bytes), ocrRunner);
    expect(ocrRunner).not.toHaveBeenCalled();
    expect(outcome.source).toEqual({ kind: "native" });
  });

  it("does NOT invoke the OCR runner for an encrypted PDF (only no_extractable_text triggers OCR)", async () => {
    const bytes = makeEncryptedPdf();
    const ocrRunner = vi.fn<OcrRunner>();
    const outcome = await runExtractionPipeline(bytes, sha256Hex(bytes), ocrRunner);
    expect(ocrRunner).not.toHaveBeenCalled();
    expect(outcome.reasons).toContain("encrypted");
  });

  it("DOES invoke the OCR runner when native text is absent, and feeds recovered OCR pages to the SAME field extractor used for native text", async () => {
    const bytes = makeBlankPdf(1);
    const ocrPages = ["Counterparty: Northwind Creator Studio Pvt Ltd", "Effective Date: 2025-03-01", "Fixed monthly fee: Rs. 45000", "Currency: INR"];
    const ocrRunner: OcrRunner = vi.fn(async () => OK_OCR_OUTCOME(ocrPages));
    const outcome = await runExtractionPipeline(bytes, sha256Hex(bytes), ocrRunner);
    expect(ocrRunner).toHaveBeenCalledTimes(1);
    expect(outcome.source.kind).toBe("ocr");
    expect(outcome.reasons).toContain("ocr_used");
    // The OCR-sourced field set is non-empty - the OCR text really did reach extractAgreementFields
    // (the SAME rule engine native text uses - no parallel/duplicate parser).
    expect(outcome.fields.length).toBeGreaterThan(0);
    expect(outcome.fields.some((field) => field.fieldKey === "currency")).toBe(true);
  });

  it("caps every OCR-sourced field's confidence at MEDIUM even when the field rule itself would have proposed HIGH (spec section 9 - OCR evidence is categorically lower trust)", async () => {
    const bytes = makeBlankPdf(1);
    // A clean, unambiguous label:value pair a native-text run would normally score HIGH.
    const ocrPages = ["Counterparty: Northwind Creator Studio Pvt Ltd", "Effective Date: 2025-03-01", "Fixed monthly fee: Rs. 45000", "Currency: INR"];
    const ocrRunner: OcrRunner = vi.fn(async () => OK_OCR_OUTCOME(ocrPages));
    const outcome = await runExtractionPipeline(bytes, sha256Hex(bytes), ocrRunner);
    for (const field of outcome.fields) expect(field.confidence, field.fieldKey).not.toBe("HIGH");
  });

  it("caps a LOW-band OCR page's fields at LOW confidence (never MEDIUM/HIGH)", async () => {
    const bytes = makeBlankPdf(1);
    const ocrPages = ["Counterparty: Northwind Creator Studio Pvt Ltd", "Effective Date: 2025-03-01"];
    const base = OK_OCR_OUTCOME(ocrPages);
    const outcome0: OcrExtractionOutcome = { ...base, pageInfo: new Map([[1, { confidence: 55, band: "LOW" as const }]]) };
    const ocrRunner: OcrRunner = vi.fn(async () => outcome0);
    const outcome = await runExtractionPipeline(bytes, sha256Hex(bytes), ocrRunner);
    for (const field of outcome.fields) expect(["LOW", "UNKNOWN"]).toContain(field.confidence);
  });

  it("maps an OCR engine failure to MANUAL_REVIEW_REQUIRED with a distinguishable ocr_ reason code, never a silent success", async () => {
    const bytes = makeBlankPdf(1);
    const ocrRunner: OcrRunner = vi.fn(async (): Promise<OcrExtractionOutcome> => ({ ok: false, reason: "no_usable_text" }));
    const outcome = await runExtractionPipeline(bytes, sha256Hex(bytes), ocrRunner);
    expect(outcome.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(outcome.reasons).toContain("ocr_no_usable_text");
    expect(outcome.fields).toEqual([]);
  });

  it("without an injected ocrRunner (the caller omits it), behavior is EXACTLY the pre-OCR native-only pipeline - a scanned PDF is reported MANUAL_REVIEW_REQUIRED with no_extractable_text and no OCR is attempted", async () => {
    const bytes = makeBlankPdf(1);
    const outcome = await runExtractionPipeline(bytes, sha256Hex(bytes));
    expect(outcome.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(outcome.reasons).toEqual(["no_extractable_text"]);
    expect(outcome.source).toEqual({ kind: "native" });
  });
});
