import { describe, expect, it, vi } from "vitest";

import { makeBlankPdf, makeTextPdf } from "@/server/finance-agreements/testing/pdf-fixtures";

import { runInvoiceExtraction, type OcrRunner, type OcrRunOutcome } from "./pipeline";

// OCR Completion stage: pipeline-shape tests with an INJECTED fake OcrRunner (no real Tesseract -
// the engine's own real end-to-end behavior is covered separately in ocr-provider.test.ts).
// Mirrors Finance Agreements' own extraction-run-builder.ocr.test.ts.

const OK_OCR = (pages: string[]): Extract<OcrRunOutcome, { ok: true }> => ({
  ok: true,
  pages,
  pageInfo: new Map(pages.map((_, index) => [index + 1, { confidence: 92, band: "USABLE" as const }])),
  providerId: "tesseract.js",
  providerVersion: "7.0.0+eng-4.0.0_best_int",
  configVersion: "raster-2.0x-v1",
});

describe("runInvoiceExtraction - OCR fallback decision (spec section 2)", () => {
  it("does NOT invoke the OCR runner for a normal text-bearing PDF", async () => {
    const bytes = makeTextPdf([["Invoice Number: INV-2026-099", "Total Due: INR 48,380"]]);
    const ocrRunner = vi.fn<OcrRunner>();
    const result = await runInvoiceExtraction(bytes, ocrRunner, "deadbeef");
    expect(ocrRunner).not.toHaveBeenCalled();
    expect(result.source).toEqual({ kind: "native" });
  });

  it("DOES invoke the OCR runner when native text is absent, and feeds recovered OCR pages to the SAME field extractor used for native text", async () => {
    const bytes = makeBlankPdf(1);
    const ocrPages = ["Invoice Number: INV-TEST-00417", "Total: Rs. 47200"];
    const ocrRunner: OcrRunner = vi.fn(async () => OK_OCR(ocrPages));
    const result = await runInvoiceExtraction(bytes, ocrRunner, "deadbeef");
    expect(ocrRunner).toHaveBeenCalledTimes(1);
    expect(result.source.kind).toBe("ocr");
    expect(result.classification.reasons).toContain("ocr_used");
    expect(result.fields.some((f) => f.fieldKey === "externalInvoiceNumber" && f.value === "INV-TEST-00417")).toBe(true);
  });

  it("caps every OCR-sourced field's confidence at MEDIUM, never HIGH (spec section 9)", async () => {
    const bytes = makeBlankPdf(1);
    const ocrPages = ["Invoice Number: INV-TEST-00417", "Total: Rs. 47200"];
    const ocrRunner: OcrRunner = vi.fn(async () => OK_OCR(ocrPages));
    const result = await runInvoiceExtraction(bytes, ocrRunner, "deadbeef");
    for (const field of result.fields) expect(field.confidence, field.fieldKey).not.toBe("HIGH");
  });

  it("maps an OCR engine failure to MANUAL_REVIEW_REQUIRED with a distinguishable ocr_ reason, never a silent success", async () => {
    const bytes = makeBlankPdf(1);
    const ocrRunner: OcrRunner = vi.fn(async (): Promise<OcrRunOutcome> => ({ ok: false, reason: "no_usable_text" }));
    const result = await runInvoiceExtraction(bytes, ocrRunner, "deadbeef");
    expect(result.classification.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(result.classification.reasons).toContain("ocr_no_usable_text");
    expect(result.fields).toEqual([]);
  });

  it("without an injected ocrRunner, behavior is EXACTLY the pre-OCR native-only pipeline", async () => {
    const bytes = makeBlankPdf(1);
    const result = await runInvoiceExtraction(bytes);
    expect(result.classification.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(result.classification.reasons).toEqual(["no_extractable_text"]);
    expect(result.source).toEqual({ kind: "native" });
  });
});
