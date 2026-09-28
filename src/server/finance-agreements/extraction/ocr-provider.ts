import { createWorker } from "tesseract.js";
import { getDocumentProxy, renderPageAsImage } from "unpdf";

// OCR Completion (this stage): a real, LOCAL, offline OCR provider - no external/cloud OCR API,
// no network call of any kind. Engine: tesseract.js (pure JS/WASM Tesseract build) for text
// recognition + unpdf's own renderPageAsImage (backed by @napi-rs/canvas) for page rasterization.
// Both install with zero native-compilation steps and run in-process inside a standard Node
// serverless function - no shell exec, no external executable, no arbitrary file paths passed to
// a subprocess.
//
// CRITICAL (do not remove): tesseract.js's createWorker DEFAULTS langPath to a jsdelivr CDN and
// will fetch the English language model over the network on first use UNLESS an explicit LOCAL
// langPath is passed. Verified directly against this package's own source
// (node_modules/tesseract.js/src/worker-script/index.js's loadLanguage): a non-URL langPath string
// takes the local adapter.readCache(...) branch exclusively, and the CDN fetch branch is
// unreachable whenever langPath is a plain filesystem path (checked with the same `is-url`
// package tesseract.js itself uses). Every createWorker() call in this file MUST pass this local
// langPath, and cacheMethod:"none" so nothing is ever read from or written to a filesystem cache
// (the committed .gz is decompressed in memory on every cold worker start - no writable temp
// directory dependency, matching this codebase's "no temp files" convention). Do not ever change
// this to a bare hostname/CDN URL, and do not make the langPath configurable via ordinary
// environment variables - the only real OCR provider this stage supports is this local one.
const OCR_ASSETS_DIR = `${process.cwd()}/src/server/finance-shared/ocr-assets`;
const OCR_LANG = "eng";

export const OCR_PROVIDER_ID = "tesseract.js";
export const OCR_PROVIDER_VERSION = "7.0.0+eng-4.0.0_best_int";
// Bumped whenever rasterization scale/limits or the provider version change - feeds the OCR
// idempotency key (a config change must produce a fresh claim, never stale cached output).
export const OCR_CONFIG_VERSION = "raster-2.0x-v1";

// --- Resource limits (section 17/33 of the OCR spec; section 7 of the addendum) -------------------
// Agreements are realistically short (a handful of pages); OCR is far more expensive than native
// text extraction (~1.1-1.2s/page warm per the addendum's real spike measurement), so the OCR cap
// is deliberately well below MAX_PDF_PAGES (60, the cheap-native-parse cap in pdf-text.ts).
export const MAX_OCR_PAGES = 15;
// Rasterization scale: ~144 effective DPI at scale 2.0, the addendum's own measured sweet spot
// (93-95% confidence on a clean fixture). Not increased without a measured reason - @napi-rs/canvas
// allocates full-resolution RGBA buffers (width * height * 4 bytes, uncompressed) in memory.
export const RASTER_SCALE = 2.0;
// Independent of scale: bounds the allocation regardless of a pathological PDF declaring an
// enormous page size (section 17 "pixel-bomb resistance" / section 37 "image bomb"). ~25 megapixels
// at RASTER_SCALE 2.0 corresponds to a source page of roughly 35" x 35" - far beyond any real
// contract page - while comfortably covering A4/Letter at this scale (roughly 2.3 MP).
export const MAX_RASTER_PIXELS = 25_000_000;
// Per-page and whole-document OCR timeouts, separate from PDF_PARSE_TIMEOUT_MS (20s - that one
// bounds cheap native pdf.js text extraction and would be far too tight for OCR). Budgeted
// generously above the addendum's warm per-page baseline (~1.2s) to absorb a cold serverless
// instance's first-ever language load.
export const OCR_PAGE_TIMEOUT_MS = 25_000;
export const OCR_TOTAL_TIMEOUT_MS = 180_000;
// A cap on total OCR-recovered text, mirroring pdf-text.ts's MAX_EXTRACTED_CHARS.
export const MAX_OCR_TEXT_CHARS = 400_000;

// --- Confidence banding (section 9 of the spec; section 5 of the addendum) -------------------------
// Grounded in the addendum's real spike: a clean fixture scored 93-95% mean OCR confidence with
// perfect recovery; a deliberately degraded (speckle-noise) fixture scored ~20% and produced
// genuinely garbled, unusable text.
export type OcrConfidenceBand = "USABLE" | "LOW" | "FAILED";
export const OCR_CONFIDENCE_USABLE_MIN = 75;
export const OCR_CONFIDENCE_LOW_MIN = 40;

export function classifyOcrConfidence(meanConfidence: number): OcrConfidenceBand {
  if (meanConfidence >= OCR_CONFIDENCE_USABLE_MIN) return "USABLE";
  if (meanConfidence >= OCR_CONFIDENCE_LOW_MIN) return "LOW";
  return "FAILED";
}

// --- Provider-neutral interface (section 3 of the spec) --------------------------------------------
export type OcrInput = { bytes: Uint8Array };
export type OcrPageResult = {
  page: number;
  text: string;
  confidence: number; // 0-100, tesseract's own mean word confidence for the page
  band: OcrConfidenceBand;
};
export type OcrFailureReason = "unreadable_pdf" | "encrypted" | "too_many_pages" | "image_too_large" | "rasterization_failed" | "timeout" | "no_usable_text";
export type OcrResult =
  | {
      ok: true;
      pages: OcrPageResult[];
      pageCount: number;
      providerId: string;
      providerVersion: string;
      configVersion: string;
      warnings: string[];
    }
  | { ok: false; reason: OcrFailureReason };

export interface OcrProvider {
  recognize(input: OcrInput): Promise<OcrResult>;
}

class TimeoutSignal {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutSignal()), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isEncryptedError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "PasswordException";
}

const PDFJS_OPTIONS = { isEvalSupported: false, verbosity: 0 } as unknown as NonNullable<Parameters<typeof getDocumentProxy>[1]>;
type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

// Rasterizes one page to PNG bytes, bounded by maxRasterPixels BEFORE the (memory-heavy) render
// call - a pathological PDF declaring a huge page size is refused up front rather than allocating
// the buffer first and checking after.
async function rasterizePage(document: PdfDocument, pageNumber: number, maxRasterPixels: number): Promise<Uint8Array> {
  const page = await document.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const width = Math.max(0, baseViewport.width) * RASTER_SCALE;
  const height = Math.max(0, baseViewport.height) * RASTER_SCALE;
  if (width * height > maxRasterPixels) throw new Error("raster_pixel_limit_exceeded");

  const buffer = await renderPageAsImage(document, pageNumber, { scale: RASTER_SCALE, canvasImport: () => import("@napi-rs/canvas") });
  return new Uint8Array(buffer as ArrayBuffer);
}

export type LocalTesseractOcrProviderOptions = {
  maxPages?: number;
  maxRasterPixels?: number;
  pageTimeoutMs?: number;
  totalTimeoutMs?: number;
};

// One real local provider: LocalTesseractOcrProvider. Provider selection for this stage is
// hardcoded (see ../extraction-ocr.ts's resolveOcrProvider) - there is no environment switch that
// can silently select a different, network-backed implementation. The constructor options exist
// ONLY so unit tests can exercise the page/pixel/timeout limits without waiting out the real
// production budgets (section 30's "page limits / pixel limits / timeout behavior" required unit
// tests) or building multi-megapixel fixtures; production code never overrides them.
export class LocalTesseractOcrProvider implements OcrProvider {
  private readonly maxPages: number;
  private readonly maxRasterPixels: number;
  private readonly pageTimeoutMs: number;
  private readonly totalTimeoutMs: number;

  constructor(options: LocalTesseractOcrProviderOptions = {}) {
    this.maxPages = options.maxPages ?? MAX_OCR_PAGES;
    this.maxRasterPixels = options.maxRasterPixels ?? MAX_RASTER_PIXELS;
    this.pageTimeoutMs = options.pageTimeoutMs ?? OCR_PAGE_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? OCR_TOTAL_TIMEOUT_MS;
  }

  async recognize(input: OcrInput): Promise<OcrResult> {
    const holder: { document: PdfDocument | null } = { document: null };
    try {
      return await withTimeout(this.run(input, holder), this.totalTimeoutMs);
    } catch (error) {
      if (error instanceof TimeoutSignal) return { ok: false, reason: "timeout" };
      if (isEncryptedError(error)) return { ok: false, reason: "encrypted" };
      return { ok: false, reason: "unreadable_pdf" };
    } finally {
      try {
        void holder.document?.loadingTask.destroy().catch(() => undefined);
      } catch {
        // ignore - best-effort cleanup only
      }
    }
  }

  private async run(input: OcrInput, holder: { document: PdfDocument | null }): Promise<OcrResult> {
    const document = await getDocumentProxy(new Uint8Array(input.bytes), PDFJS_OPTIONS);
    holder.document = document;
    const pageCount = document.numPages;
    if (pageCount > this.maxPages) return { ok: false, reason: "too_many_pages" };

    // One worker for the whole document (every page shares the same local language data) -
    // created once, terminated once, per OCR request. A fresh worker per request (rather than a
    // pooled/reused worker) is the simplest safe choice for a stage-1 implementation in a
    // serverless-shaped runtime where a long-lived pool cannot be assumed to survive between
    // invocations; see the completion report for the documented tradeoff.
    const worker = await createWorker(OCR_LANG, undefined, {
      langPath: OCR_ASSETS_DIR,
      cachePath: OCR_ASSETS_DIR,
      cacheMethod: "none",
      gzip: true,
      logger: () => undefined,
    });

    const warnings: string[] = [];
    const pages: OcrPageResult[] = [];
    let remaining = MAX_OCR_TEXT_CHARS;
    let anyUsable = false;
    try {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
        try {
          const png = await withTimeout(rasterizePage(document, pageNumber, this.maxRasterPixels), this.pageTimeoutMs);
          const recognized = await withTimeout(worker.recognize(Buffer.from(png)), this.pageTimeoutMs);
          const confidence = typeof recognized.data.confidence === "number" ? recognized.data.confidence : 0;
          const band = classifyOcrConfidence(confidence);
          let text = band === "FAILED" ? "" : (recognized.data.text ?? "");
          if (text.length > remaining) {
            text = text.slice(0, Math.max(0, remaining));
            warnings.push(`ocr_text_truncated:page_${pageNumber}`);
          }
          remaining -= text.length;
          if (band !== "FAILED") anyUsable = true;
          pages.push({ page: pageNumber, text, confidence, band });
        } catch (pageError) {
          // A single bad page (corrupt image data, a per-page timeout) must not sink every other
          // page in the document - it is recorded as FAILED and the loop continues.
          warnings.push(pageError instanceof TimeoutSignal ? `ocr_page_timeout:page_${pageNumber}` : `ocr_page_failed:page_${pageNumber}`);
          pages.push({ page: pageNumber, text: "", confidence: 0, band: "FAILED" });
        }
      }
    } finally {
      await worker.terminate().catch(() => undefined);
    }

    if (!anyUsable) return { ok: false, reason: "no_usable_text" };
    return { ok: true, pages, pageCount, providerId: OCR_PROVIDER_ID, providerVersion: OCR_PROVIDER_VERSION, configVersion: OCR_CONFIG_VERSION, warnings };
  }
}
