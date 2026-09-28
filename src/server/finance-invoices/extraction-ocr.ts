import { createHash } from "node:crypto";

import { getInvoiceOcrRunDoc, setInvoiceOcrRunDoc } from "./firestore";
import { LocalTesseractOcrProvider, OCR_CONFIG_VERSION, OCR_PROVIDER_ID, OCR_PROVIDER_VERSION, type OcrConfidenceBand, type OcrFailureReason, type OcrPageResult, type OcrProvider } from "./extraction/ocr-provider";
import type { PdfTextResult } from "./extraction/pdf-text";

// OCR Completion stage: the orchestration seam between the pure pipeline (extraction/pipeline.ts)
// and the real local OCR engine (extraction/ocr-provider.ts). This file MAY touch Firestore (the
// OCR text cache, via firestore.ts's own exported helpers only - never getAdminFirestore()
// directly, per this module's own static guard) - it lives at the module root, mirroring Finance
// Agreements' own extraction-ocr.ts.
//
// Provider selection is HARDCODED to the local provider (section 25 of the spec / section 9 of the
// addendum) - no environment variable can select a different, network-backed implementation.
let providerOverride: OcrProvider | "DISABLED" | null = null;
let cachedProvider: LocalTesseractOcrProvider | null = null;

export function getOcrProvider(): OcrProvider | null {
  if (providerOverride === "DISABLED") return null;
  if (providerOverride) return providerOverride;
  cachedProvider ??= new LocalTesseractOcrProvider();
  return cachedProvider;
}

export function setOcrProviderForTests(provider: OcrProvider | "DISABLED" | null): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) throw new Error("setOcrProviderForTests may only be called from a test run.");
  providerOverride = provider;
}

// sha256(artifactSha256|providerId|providerVersion|configVersion) - same idempotency idiom as
// Finance Agreements' own ocrClaimId.
export const OCR_CLAIM_ID_PREFIX = "ocr_";
export function ocrClaimId(artifactSha256: string): string {
  return `${OCR_CLAIM_ID_PREFIX}${createHash("sha256").update(`${artifactSha256}|${OCR_PROVIDER_ID}|${OCR_PROVIDER_VERSION}|${OCR_CONFIG_VERSION}`).digest("hex")}`;
}

export type OcrPageInfo = { confidence: number; band: OcrConfidenceBand };
type OkPdfTextResult = Extract<PdfTextResult, { ok: true }>;
export type OcrExtractionOutcome =
  | { ok: true; pdf: OkPdfTextResult; pageInfo: Map<number, OcrPageInfo>; providerId: string; providerVersion: string; configVersion: string; warnings: string[] }
  | { ok: false; reason: OcrFailureReason };

function pagesToPdfTextResult(pages: OcrPageResult[], pageCount: number): OkPdfTextResult {
  const texts = pages.map((page) => page.text);
  const totalChars = texts.reduce((sum, text) => sum + text.length, 0);
  return { ok: true, pages: texts, pageCount, totalChars, truncated: { chars: false } };
}

// bytes -> OCR outcome, with a best-effort cache lookup/write keyed by the idempotency claim above
// (see Finance Agreements' own extraction-ocr.ts for the full non-transactional-cache rationale).
export async function runOcrForInvoice(bytes: Uint8Array, artifactSha256: string): Promise<OcrExtractionOutcome> {
  const claimId = ocrClaimId(artifactSha256);
  const cached = await getInvoiceOcrRunDoc(claimId).catch(() => null);
  if (cached && cached.artifactSha256 === artifactSha256) {
    const pageInfo = new Map(cached.pages.map((page) => [page.page, { confidence: page.confidence, band: page.band }] as const));
    return { ok: true, pdf: pagesToPdfTextResult(cached.pages, cached.pageCount), pageInfo, providerId: cached.providerId, providerVersion: cached.providerVersion, configVersion: cached.configVersion, warnings: [] };
  }

  const provider = getOcrProvider();
  if (!provider) return { ok: false, reason: "unreadable_pdf" };

  const result = await provider.recognize({ bytes });
  if (!result.ok) return { ok: false, reason: result.reason };

  await setInvoiceOcrRunDoc({
    claimId,
    artifactSha256,
    providerId: result.providerId,
    providerVersion: result.providerVersion,
    configVersion: result.configVersion,
    pageCount: result.pageCount,
    pages: result.pages.map((page) => ({ page: page.page, text: page.text, confidence: page.confidence, band: page.band })),
    createdAt: new Date().toISOString(),
  }).catch(() => undefined);

  const pageInfo = new Map(result.pages.map((page) => [page.page, { confidence: page.confidence, band: page.band }] as const));
  return { ok: true, pdf: pagesToPdfTextResult(result.pages, result.pageCount), pageInfo, providerId: result.providerId, providerVersion: result.providerVersion, configVersion: result.configVersion, warnings: result.warnings };
}
