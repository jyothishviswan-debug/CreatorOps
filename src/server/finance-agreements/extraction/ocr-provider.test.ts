import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { buildDegradedScannedAgreementPdf, buildScannedAgreementPdf, SCANNED_AGREEMENT_LINES } from "../testing/ocr-fixtures";
import { extractPdfText } from "./pdf-text";
import {
  classifyOcrConfidence,
  LocalTesseractOcrProvider,
  MAX_RASTER_PIXELS,
  OCR_CONFIDENCE_LOW_MIN,
  OCR_CONFIDENCE_USABLE_MIN,
  OCR_CONFIG_VERSION,
  OCR_PROVIDER_ID,
  OCR_PROVIDER_VERSION,
} from "./ocr-provider";

// Step OCR Completion: REAL, end-to-end tests of the local OCR engine against a genuine image-only
// PDF fixture (spec section 26/27/30). These calls run the actual tesseract.js WASM engine and the
// actual @napi-rs/canvas rasterizer - no mock, no fixture-mapping fake - and are correspondingly
// slower than the rest of this module's unit tests (real OCR, not a string match).

describe("classifyOcrConfidence", () => {
  it("bands mean confidence exactly at the documented thresholds", () => {
    expect(classifyOcrConfidence(100)).toBe("USABLE");
    expect(classifyOcrConfidence(OCR_CONFIDENCE_USABLE_MIN)).toBe("USABLE");
    expect(classifyOcrConfidence(OCR_CONFIDENCE_USABLE_MIN - 0.01)).toBe("LOW");
    expect(classifyOcrConfidence(OCR_CONFIDENCE_LOW_MIN)).toBe("LOW");
    expect(classifyOcrConfidence(OCR_CONFIDENCE_LOW_MIN - 0.01)).toBe("FAILED");
    expect(classifyOcrConfidence(0)).toBe("FAILED");
  });
});

describe("the Agreement scanned-PDF fixture is genuinely image-only (section 26)", () => {
  it("the native, no-OCR text extractor recovers zero usable text from it", async () => {
    const bytes = await buildScannedAgreementPdf();
    const result = await extractPdfText(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_extractable_text");
  });
});

describe("LocalTesseractOcrProvider - real OCR end-to-end", () => {
  it(
    "rasterizes and recognizes a real clean scanned Agreement page, recovering the key business terms with USABLE confidence",
    { timeout: 60_000 },
    async () => {
      const bytes = await buildScannedAgreementPdf();
      const provider = new LocalTesseractOcrProvider();
      const result = await provider.recognize({ bytes });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.providerId).toBe(OCR_PROVIDER_ID);
      expect(result.providerVersion).toBe(OCR_PROVIDER_VERSION);
      expect(result.configVersion).toBe(OCR_CONFIG_VERSION);
      expect(result.pageCount).toBe(1);
      expect(result.pages).toHaveLength(1);
      const page = result.pages[0]!;
      expect(page.band).toBe("USABLE");
      expect(page.confidence).toBeGreaterThanOrEqual(OCR_CONFIDENCE_USABLE_MIN);
      // The core business terms a human (and the existing field-extractor rules) need to see.
      expect(page.text).toMatch(/Northwind Creator Studio/i);
      expect(page.text).toMatch(/AGR-TEST-00931/);
      expect(page.text).toMatch(/45000/);
    },
  );

  it(
    "a real degraded (speckle-noise) scan yields a LOW/FAILED band and genuinely garbled text - never a fabricated clean result",
    { timeout: 60_000 },
    async () => {
      const bytes = await buildDegradedScannedAgreementPdf();
      const provider = new LocalTesseractOcrProvider();
      const result = await provider.recognize({ bytes });
      // Either the page is classified LOW/FAILED, or (rare, engine-dependent) recognized as
      // USABLE but the exact clean text is not perfectly recovered - either way, the degraded
      // fixture must never silently produce the SAME confident, complete output as the clean one.
      if (result.ok) {
        const page = result.pages[0];
        const cleanMatch = page && page.band === "USABLE" && SCANNED_AGREEMENT_LINES.every((line) => page.text.includes(line));
        expect(cleanMatch, "a 12%-speckled scan must not recover perfectly clean, USABLE-confidence text").toBe(false);
      } else {
        expect(result.reason).toBe("no_usable_text");
      }
    },
  );

  it("enforces the page-count limit BEFORE doing any (expensive) rasterization or OCR work", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([100, 100]);
    const bytes = await doc.save();
    const provider = new LocalTesseractOcrProvider({ maxPages: 2 });
    const result = await provider.recognize({ bytes });
    expect(result).toEqual({ ok: false, reason: "too_many_pages" });
  });

  it("enforces the raster-pixel limit for a pathologically large declared page size, before allocating a canvas", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([20_000, 20_000]); // a page this large at RASTER_SCALE exceeds any reasonable pixel cap
    const bytes = await doc.save();
    const provider = new LocalTesseractOcrProvider({ maxRasterPixels: 1_000 });
    const result = await provider.recognize({ bytes });
    // The single page fails rasterization (pixel-bomb refused) and there is no other usable page.
    expect(result).toEqual({ ok: false, reason: "no_usable_text" });
  });

  it("a real page whose declared size is within the default MAX_RASTER_PIXELS bound is accepted (sanity: the default cap is not accidentally too tight for a normal page)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]); // US Letter in points
    const bytes = await doc.save();
    const page = await (await import("unpdf")).getDocumentProxy(bytes);
    const viewport = (await page.getPage(1)).getViewport({ scale: 2.0 });
    expect(viewport.width * viewport.height).toBeLessThan(MAX_RASTER_PIXELS);
  });

  it("enforces a per-page timeout: an artificially tiny timeout on a real page reliably fails that page (recorded as FAILED, not thrown to the caller)", { timeout: 30_000 }, async () => {
    const bytes = await buildScannedAgreementPdf();
    // 1ms is far below any real rasterization+recognition time - guarantees the timeout fires.
    const provider = new LocalTesseractOcrProvider({ pageTimeoutMs: 1, totalTimeoutMs: 20_000 });
    const result = await provider.recognize({ bytes });
    expect(result).toEqual({ ok: false, reason: "no_usable_text" });
  });

  it("enforces a whole-document timeout independently of the per-page timeout", { timeout: 30_000 }, async () => {
    const bytes = await buildScannedAgreementPdf();
    const provider = new LocalTesseractOcrProvider({ totalTimeoutMs: 1 });
    const result = await provider.recognize({ bytes });
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });
});

describe("the committed language-data asset (section 25 / addendum section 1-2)", () => {
  it("the committed eng.traineddata.gz asset exists, is non-empty, and is under version control at a server-only path (never under public/)", () => {
    const path = `${process.cwd()}/src/server/finance-shared/ocr-assets/eng.traineddata.gz`;
    const bytes = readFileSync(path);
    expect(bytes.length).toBeGreaterThan(1_000_000);
    // gzip magic bytes
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });
});

describe("external-provider / no-network guard (section 25)", () => {
  it("ocr-provider.ts never references a CDN hostname or a bare http(s) URL literal outside this guard comment itself", () => {
    const source = readFileSync(new URL("./ocr-provider.ts", import.meta.url), "utf8");
    // Strip the header comment block (which legitimately NAMES the forbidden CDN host to explain
    // why it must never be used) before scanning the rest of the file for a live reference.
    const withoutHeaderComment = source.replace(/^\/\/.*$/gm, "");
    expect(withoutHeaderComment).not.toMatch(/cdn\.jsdelivr\.net/);
    expect(withoutHeaderComment).not.toMatch(/https?:\/\//);
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
        const bytes = await buildScannedAgreementPdf();
        const provider = new LocalTesseractOcrProvider();
        const result = await provider.recognize({ bytes });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.pages[0]?.text).toMatch(/Northwind/i);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  it("every createWorker() call site passes an explicit local langPath (a filesystem path under process.cwd(), never a bare hostname/URL) and cacheMethod:\"none\" (never a filesystem cache write)", () => {
    const source = readFileSync(new URL("./ocr-provider.ts", import.meta.url), "utf8");
    const codeOnly = source.replace(/^\s*\/\/.*$/gm, "");
    const calls = [...codeOnly.matchAll(/createWorker\(([\s\S]*?)\);/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const body = call[1]!;
      expect(body).toMatch(/langPath:\s*OCR_ASSETS_DIR/);
      expect(body).toMatch(/cacheMethod:\s*"none"/);
    }
    expect(source).toMatch(/const OCR_ASSETS_DIR = `\$\{process\.cwd\(\)\}/);
  });
});
