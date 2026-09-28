import { buildScannedPdf } from "@/server/finance-shared/ocr-testing/build-scanned-pdf";

// OCR Completion stage: a REAL image-only (scanned) Agreement PDF fixture - clearly synthetic
// test-only values (spec section 26). No PDF text operators anywhere (proven by ocr-provider's own
// test asserting the native extractor sees zero usable text before trusting this fixture).
export const SCANNED_AGREEMENT_LINES = [
  "CREATOR COLLABORATION AGREEMENT",
  "This Agreement is made between Northwind Creator Studio Pvt Ltd",
  "and the Creator, effective 2025-03-01.",
  "Agreement Number: AGR-TEST-00931",
  "Fixed monthly fee: Rs. 45000",
  "Required qualifying content: 4 posts per month",
  "Platform: Instagram",
  "Term: 12 months from the effective date",
];

export async function buildScannedAgreementPdf(): Promise<Uint8Array> {
  return buildScannedPdf([{ lines: SCANNED_AGREEMENT_LINES }]);
}

// The mandatory degraded/low-confidence fixture (section 27): dense random speckle noise overlaid
// before rendering to PNG - a realistic "bad scan", not a contrived edge case.
export async function buildDegradedScannedAgreementPdf(): Promise<Uint8Array> {
  return buildScannedPdf([{ lines: SCANNED_AGREEMENT_LINES, noiseRatio: 0.12 }]);
}
