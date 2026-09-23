import { describe, expect, it } from "vitest";

import { makeBlankPdf, makeEncryptedPdf, makeGarbagePdf, makeTextPdf } from "@/server/finance-agreements/testing/pdf-fixtures";

import { runInvoiceExtraction } from "./pipeline";

// Step 15C section 19/24: end-to-end pipeline tests over REAL, structurally-valid PDF byte
// buffers - the same precedent Agreement extraction's own pipeline.test.ts established (never a
// mocked "fake extraction service" - see extraction/types.ts's header for why).

const CLEAN_INVOICE = [
  ["Invoice Number: INV-2026-099", "Invoice Date: 1 April 2026", "Due Date: 15 April 2026", "Sub Total: INR 41,000", "GST @ 18%", "Total Due: INR 48,380"],
];

describe("runInvoiceExtraction", () => {
  it("EXTRACTED: a clean single-page invoice recovers both core fields with no manual-review reasons", async () => {
    const pdf = makeTextPdf(CLEAN_INVOICE);
    const result = await runInvoiceExtraction(pdf);
    expect(result.classification.status).toBe("EXTRACTED");
    expect(result.classification.missingCore).toEqual([]);
    expect(result.fields.find((f) => f.fieldKey === "externalInvoiceNumber")?.value).toBe("INV-2026-099");
    expect(result.fields.find((f) => f.fieldKey === "declaredTotalMinor")?.value).toBe(4_838_000);
  });

  it("PARTIAL: only the invoice number recovered - declaredTotalMinor is missing, never invented", async () => {
    const pdf = makeTextPdf([["Invoice Number: INV-2026-100", "No total is stated anywhere on this page."]]);
    const result = await runInvoiceExtraction(pdf);
    expect(result.classification.status).toBe("PARTIAL");
    expect(result.classification.missingCore).toEqual(["declaredTotalMinor"]);
  });

  it("MANUAL_REVIEW_REQUIRED: a blank (scanned-document stand-in) PDF proposes nothing", async () => {
    const pdf = makeBlankPdf(1);
    const result = await runInvoiceExtraction(pdf);
    expect(result.classification.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(result.fields).toEqual([]);
    expect(result.classification.missingCore).toEqual(["externalInvoiceNumber", "declaredTotalMinor"]);
  });

  it("MANUAL_REVIEW_REQUIRED: an encrypted PDF cannot be read at all", async () => {
    const pdf = makeEncryptedPdf();
    const result = await runInvoiceExtraction(pdf);
    expect(result.classification.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(result.classification.reasons).toContain("pdf_unreadable");
  });

  it("MANUAL_REVIEW_REQUIRED: garbage bytes never crash the pipeline, and never invent fields", async () => {
    const pdf = makeGarbagePdf();
    const result = await runInvoiceExtraction(pdf);
    expect(result.classification.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(result.fields).toEqual([]);
  });

  it("every proposal is unconfirmed and no PAN/Aadhaar/bank field key exists in the closed set at all", async () => {
    const pdf = makeTextPdf(CLEAN_INVOICE);
    const result = await runInvoiceExtraction(pdf);
    for (const field of result.fields) {
      expect(field.requiresHumanConfirmation).toBe(true);
      expect(["externalInvoiceNumber", "invoiceDate", "supplierName", "currency", "subtotalMinor", "taxLabel", "taxRateBps", "taxAmountMinor", "declaredTotalMinor", "dueDate", "servicePeriod", "gstin"]).toContain(field.fieldKey);
    }
  });
});
