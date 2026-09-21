import { describe, expect, it } from "vitest";

import { SAMPLE_CONTRACT_PAGES } from "../testing/sample-contract";
import { makeBlankPdf, makeGarbagePdf, makeTextPdf } from "../testing/pdf-fixtures";
import { classifyExtraction, splitRestricted } from "./extraction-result";
import { extractAgreementFields } from "./field-extractors";
import { extractPdfText } from "./pdf-text";

// End to end over REAL PDF bytes: pdf -> text -> proposals -> classification -> split.
async function runPipeline(pdf: Buffer) {
  const text = await extractPdfText(pdf);
  const extraction = text.ok ? extractAgreementFields(text.pages) : { fields: [], warnings: [] };
  return { text, ...extraction, classification: classifyExtraction(text, extraction.fields, extraction.warnings) };
}

describe("extraction pipeline over real PDF bytes", () => {
  it("extracts the synthetic contract page by page and classifies it EXTRACTED", async () => {
    const out = await runPipeline(makeTextPdf(SAMPLE_CONTRACT_PAGES));
    expect(out.text.ok).toBe(true);
    expect(out.classification.status).toBe("EXTRACTED");
    const byKey = new Map(out.fields.map((f) => [f.fieldKey, f]));
    // page numbers survive the PDF round trip
    expect(byKey.get("counterpartyName")).toMatchObject({ normalizedValue: "Sample Creator Studio", page: 1 });
    expect(byKey.get("effectiveDate")).toMatchObject({ normalizedValue: "2025-04-01", page: 2 });
    expect(byKey.get("fixedComponent")).toMatchObject({ normalizedValue: { applicable: true, amountMinor: 2_500_000 }, page: 2 });
    expect(byKey.get("incentive")).toMatchObject({ page: 3 });
    expect(byKey.get("panNumber")).toMatchObject({ normalizedValue: "ABCPE1234F", restricted: true });
    const split = splitRestricted(out.fields);
    expect(JSON.stringify(split.ordinary)).not.toContain("ABCPE1234F");
  });

  it("a scan stand-in (no text layer) is MANUAL_REVIEW_REQUIRED / no_extractable_text with no fields", async () => {
    const out = await runPipeline(makeBlankPdf(4));
    expect(out.fields).toEqual([]);
    expect(out.classification).toEqual({ status: "MANUAL_REVIEW_REQUIRED", reasons: ["no_extractable_text"], missingCore: [], fieldCount: 0 });
  });

  it("a malformed PDF is a safe MANUAL_REVIEW_REQUIRED / unreadable_pdf, never a throw, never partial garbage", async () => {
    const out = await runPipeline(makeGarbagePdf());
    expect(out.fields).toEqual([]);
    expect(out.classification).toEqual({ status: "MANUAL_REVIEW_REQUIRED", reasons: ["unreadable_pdf"], missingCore: [], fieldCount: 0 });
  });
});
