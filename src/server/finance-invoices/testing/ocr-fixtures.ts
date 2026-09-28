import { buildScannedPdf } from "@/server/finance-shared/ocr-testing/build-scanned-pdf";

// OCR Completion stage: a REAL image-only (scanned) Invoice PDF fixture - clearly synthetic
// test-only values (spec section 26). No PDF text operators anywhere.
export const SCANNED_INVOICE_LINES = [
  "TAX INVOICE",
  "From: Northwind Creator Studio Pvt Ltd",
  "123 Lake View Road, Bengaluru, Karnataka",
  "GSTIN 27ABCDE1234F1Z5",
  "Invoice Number: INV-TEST-00417",
  "Invoice Date: 2025-03-01",
  "Sub Total: Rs. 40000",
  "GST 18%",
  "Total: Rs. 47200",
  "Bank Account Number: 123456789012",
];

export async function buildScannedInvoicePdf(): Promise<Uint8Array> {
  return buildScannedPdf([{ lines: SCANNED_INVOICE_LINES }]);
}

// The mandatory degraded/low-confidence fixture (section 27).
export async function buildDegradedScannedInvoicePdf(): Promise<Uint8Array> {
  return buildScannedPdf([{ lines: SCANNED_INVOICE_LINES, noiseRatio: 0.12 }]);
}
