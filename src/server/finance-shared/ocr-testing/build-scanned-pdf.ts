import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";

// OCR Completion stage: builds a REAL image-only PDF fixture for tests - no PDF text operators
// anywhere, genuinely scanned-shaped bytes (spec section 26). Shared by both Finance Agreements'
// and Finance Invoices' own test suites (test-only code; neither module's static production-file
// guards scan this file, since it lives outside both module directories entirely).
//
// Technique: render each page's lines onto an in-memory @napi-rs/canvas canvas, export to PNG,
// then embed that PNG as a full-page image in a fresh pdf-lib PDF (drawImage only - no text
// operators). A caller MUST additionally assert (via the real text extractor) that the built PDF
// yields zero extractable text before trusting it as "image-only" - see each module's own OCR
// fixture test for that proof.

export type ScannedPageSpec = { lines: string[]; noiseRatio?: number };

const PAGE_WIDTH = 850;
const PAGE_HEIGHT = 1100;

// Overlays `ratio` of pixels with random pure black/white speckle - a realistic "bad scan"
// simulation (not a contrived edge case), used to build the mandatory degraded/low-confidence
// fixture (spec section 27).
function applySpeckleNoise(imageData: Uint8ClampedArray, width: number, height: number, ratio: number): void {
  const pixelCount = width * height;
  const noisyCount = Math.floor(pixelCount * ratio);
  for (let i = 0; i < noisyCount; i++) {
    const pixelIndex = Math.floor(Math.random() * pixelCount) * 4;
    const value = Math.random() < 0.5 ? 0 : 255;
    imageData[pixelIndex] = value;
    imageData[pixelIndex + 1] = value;
    imageData[pixelIndex + 2] = value;
    imageData[pixelIndex + 3] = 255;
  }
}

function renderPagePng(spec: ScannedPageSpec): Buffer {
  const canvas = createCanvas(PAGE_WIDTH, PAGE_HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  ctx.fillStyle = "#000000";
  ctx.font = "28px sans-serif";
  ctx.textBaseline = "top";

  let y = 60;
  for (const line of spec.lines) {
    ctx.fillText(line, 50, y);
    y += 42;
  }

  if (spec.noiseRatio && spec.noiseRatio > 0) {
    const imageData = ctx.getImageData(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    applySpeckleNoise(imageData.data, PAGE_WIDTH, PAGE_HEIGHT, spec.noiseRatio);
    ctx.putImageData(imageData, 0, 0);
  }

  return canvas.toBuffer("image/png");
}

// Builds a genuine image-only, multi-page PDF: one full-page PNG per page, no text operators.
export async function buildScannedPdf(pages: ScannedPageSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const pageSpec of pages) {
    const png = renderPagePng(pageSpec);
    const image = await doc.embedPng(png);
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  }
  return doc.save();
}
