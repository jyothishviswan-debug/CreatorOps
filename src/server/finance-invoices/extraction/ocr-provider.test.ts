import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { buildDegradedScannedInvoicePdf, buildScannedInvoicePdf, SCANNED_INVOICE_LINES } from "../testing/ocr-fixtures";
import { extractPdfText } from "./pdf-text";
import { classifyOcrConfidence, LocalTesseractOcrProvider, OCR_CONFIDENCE_LOW_MIN, OCR_CONFIDENCE_USABLE_MIN, OCR_CONFIG_VERSION, OCR_PROVIDER_ID, OCR_PROVIDER_VERSION } from "./ocr-provider";

// OCR Completion stage: REAL, end-to-end tests of the local OCR engine against a genuine
// image-only Invoice PDF fixture (spec section 26/27/30) - real tesseract.js + real @napi-rs/canvas
// rasterization, no mock, no fixture-mapping fake. Mirrors Finance Agreements' own
// extraction/ocr-provider.test.ts (this is a deliberate local copy of that module).

describe("classifyOcrConfidence", () => {
  it("bands mean confidence exactly at the documented thresholds", () => {
    expect(classifyOcrConfidence(100)).toBe("USABLE");
    expect(classifyOcrConfidence(OCR_CONFIDENCE_USABLE_MIN)).toBe("USABLE");
    expect(classifyOcrConfidence(OCR_CONFIDENCE_USABLE_MIN - 0.01)).toBe("LOW");
    expect(classifyOcrConfidence(OCR_CONFIDENCE_LOW_MIN)).toBe("LOW");
    expect(classifyOcrConfidence(OCR_CONFIDENCE_LOW_MIN - 0.01)).toBe("FAILED");
  });
});

describe("the Invoice scanned-PDF fixture is genuinely image-only (section 26)", () => {
  it("the native, no-OCR text extractor recovers zero usable text from it", async () => {
    const bytes = await buildScannedInvoicePdf();
    const result = await extractPdfText(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_extractable_text");
  });
});

describe("LocalTesseractOcrProvider - real OCR end-to-end (Invoice)", () => {
  it(
    "rasterizes and recognizes a real clean scanned Invoice page, recovering supplier/invoice-number/total/GSTIN evidence with USABLE confidence",
    { timeout: 60_000 },
    async () => {
      const bytes = await buildScannedInvoicePdf();
      const provider = new LocalTesseractOcrProvider();
      const result = await provider.recognize({ bytes });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.providerId).toBe(OCR_PROVIDER_ID);
      expect(result.providerVersion).toBe(OCR_PROVIDER_VERSION);
      expect(result.configVersion).toBe(OCR_CONFIG_VERSION);
      const page = result.pages[0]!;
      expect(page.band).toBe("USABLE");
      expect(page.text).toMatch(/Northwind Creator Studio/i);
      expect(page.text).toMatch(/INV-TEST-00417/);
      expect(page.text).toMatch(/47200/);
      expect(page.text).toMatch(/27ABCDE1234F1Z5/);
    },
  );

  it(
    "a real degraded (speckle-noise) scan never silently recovers the SAME clean, USABLE-confidence text as the clean fixture",
    { timeout: 60_000 },
    async () => {
      const bytes = await buildDegradedScannedInvoicePdf();
      const provider = new LocalTesseractOcrProvider();
      const result = await provider.recognize({ bytes });
      if (result.ok) {
        const page = result.pages[0];
        const cleanMatch = page && page.band === "USABLE" && SCANNED_INVOICE_LINES.every((line) => page.text.includes(line));
        expect(cleanMatch, "a 12%-speckled scan must not recover perfectly clean, USABLE-confidence text").toBe(false);
      } else {
        expect(result.reason).toBe("no_usable_text");
      }
    },
  );

  it("enforces the page-count limit before doing any rasterization/OCR work", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([100, 100]);
    const bytes = await doc.save();
    const provider = new LocalTesseractOcrProvider({ maxPages: 2 });
    expect(await provider.recognize({ bytes })).toEqual({ ok: false, reason: "too_many_pages" });
  });

  it("enforces the raster-pixel limit for a pathologically large declared page size", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([20_000, 20_000]);
    const bytes = await doc.save();
    const provider = new LocalTesseractOcrProvider({ maxRasterPixels: 1_000 });
    expect(await provider.recognize({ bytes })).toEqual({ ok: false, reason: "no_usable_text" });
  });

  it(
    "REAL proof of zero network calls: recognition still succeeds end-to-end with global fetch patched to throw",
    { timeout: 60_000 },
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => {
        throw new Error("network access attempted during OCR - this must never happen");
      }) as typeof fetch;
      try {
        const bytes = await buildScannedInvoicePdf();
        const provider = new LocalTesseractOcrProvider();
        const result = await provider.recognize({ bytes });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.pages[0]?.text).toMatch(/Northwind/i);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

describe("external-provider / no-network guard (section 25)", () => {
  it("ocr-provider.ts never references a CDN hostname or a bare http(s) URL literal outside comments", () => {
    const source = readFileSync(new URL("./ocr-provider.ts", import.meta.url), "utf8");
    const withoutComments = source.replace(/^\s*\/\/.*$/gm, "");
    expect(withoutComments).not.toMatch(/cdn\.jsdelivr\.net/);
    expect(withoutComments).not.toMatch(/https?:\/\//);
  });

  it('every createWorker() call site passes an explicit local langPath and cacheMethod:"none"', () => {
    const source = readFileSync(new URL("./ocr-provider.ts", import.meta.url), "utf8");
    const codeOnly = source.replace(/^\s*\/\/.*$/gm, "");
    const calls = [...codeOnly.matchAll(/createWorker\(([\s\S]*?)\);/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1]!).toMatch(/langPath:\s*OCR_ASSETS_DIR/);
      expect(call[1]!).toMatch(/cacheMethod:\s*"none"/);
    }
    expect(source).toMatch(/const OCR_ASSETS_DIR = `\$\{process\.cwd\(\)\}/);
    // reuses the SAME committed asset as Agreements (not a second copy of the 2.95MB file)
    expect(source).toMatch(/finance-shared\/ocr-assets/);
  });
});
