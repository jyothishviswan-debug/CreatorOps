import { createHash } from "node:crypto";

import { getOcrRunDoc, setOcrRunDoc } from "./firestore";
import { LocalTesseractOcrProvider, OCR_CONFIG_VERSION, OCR_PROVIDER_ID, OCR_PROVIDER_VERSION, type OcrPageResult, type OcrProvider, type OcrFailureReason } from "./extraction/ocr-provider";
import type { PdfTextResult } from "./extraction/pdf-text";
import type { OcrConfidenceBand } from "./extraction/ocr-provider";

// OCR Completion stage: the orchestration seam between the pure pipeline (extraction-run-builder.ts)
// and the real local OCR engine (extraction/ocr-provider.ts). This file MAY touch Firestore (the
// OCR text cache) - it lives at the module root, not inside extraction/, exactly like
// extraction-service.ts already does for the rest of the extraction flow.
//
// Provider selection is HARDCODED to the local provider (section 25 of the spec / section 9 of the
// addendum): there is no environment variable that can select a different, network-backed OCR
// implementation. A test override exists (setOcrProviderForTests) purely so unit tests can
// substitute a fast fake for pipeline-shape tests - it throws outside a test run, mirroring
// document-storage/index.ts's own setInvoiceDocumentStorageForTests seam. Real OCR-fixture tests
// use the REAL LocalTesseractOcrProvider (no override), per the spec's explicit requirement that at
// least one real local OCR implementation processes real scanned fixture bytes end-to-end.
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

// --- Idempotency claim (section 15) -----------------------------------------------------------------
// sha256(artifactSha256|providerId|providerVersion|configVersion). Same document bytes + same OCR
// engine/rasterization config => the same claim => cached page text is reused; a re-uploaded
// document (different bytes -> different sha256) or a future OCR engine/config upgrade (different
// providerVersion/configVersion) always gets a fresh claim, never stale output.
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

// bytes -> OCR outcome, with a best-effort cache lookup/write keyed by the idempotency claim above.
// The cache is intentionally non-transactional (a benign race between two concurrent first-time OCR
// requests for the same document may run Tesseract twice and both writers converge on the SAME
// deterministic claim id and equivalent content - never a correctness issue, only a possible
// redundant computation on the very first concurrent request). Correctness against a STALE result
// racing a newer document version is enforced separately, at the extraction-run transaction in
// extraction-service.ts (only the currently-open version may record a run), matching section 16's
// "stale job/result must be ignored, not overwrite newer evidence" requirement.
export async function runOcrForAgreement(bytes: Uint8Array, artifactSha256: string): Promise<OcrExtractionOutcome> {
  const claimId = ocrClaimId(artifactSha256);
  const cached = await getOcrRunDoc(claimId).catch(() => null);
  if (cached && cached.artifactSha256 === artifactSha256) {
    const pageInfo = new Map(cached.pages.map((page) => [page.page, { confidence: page.confidence, band: page.band }] as const));
    return { ok: true, pdf: pagesToPdfTextResult(cached.pages, cached.pageCount), pageInfo, providerId: cached.providerId, providerVersion: cached.providerVersion, configVersion: cached.configVersion, warnings: [] };
  }

  const provider = getOcrProvider();
  if (!provider) return { ok: false, reason: "unreadable_pdf" };

  const result = await provider.recognize({ bytes });
  if (!result.ok) return { ok: false, reason: result.reason };

  await setOcrRunDoc({
    claimId,
    artifactSha256,
    providerId: result.providerId,
    providerVersion: result.providerVersion,
    configVersion: result.configVersion,
    pageCount: result.pageCount,
    pages: result.pages.map((page) => ({ page: page.page, text: page.text, confidence: page.confidence, band: page.band })),
    createdAt: new Date().toISOString(),
  }).catch(() => undefined); // best-effort: a cache-write failure must never fail the OCR run itself

  const pageInfo = new Map(result.pages.map((page) => [page.page, { confidence: page.confidence, band: page.band }] as const));
  return { ok: true, pdf: pagesToPdfTextResult(result.pages, result.pageCount), pageInfo, providerId: result.providerId, providerVersion: result.providerVersion, configVersion: result.configVersion, warnings: result.warnings };
}
