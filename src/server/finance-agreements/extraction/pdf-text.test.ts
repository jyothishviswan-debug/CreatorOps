import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { makeBlankPdf, makeEncryptedPdf, makeGarbagePdf, makeNotAPdf, makeTextPdf, makeTruncatedPdf } from "../testing/pdf-fixtures";
import { MAX_PDF_PAGES, MIN_EXTRACTABLE_CHARS, PARSER_VERSION, extractPdfText, normalizePageText } from "./pdf-text";

const longLine = "This Agreement is made between the Company and the Collaborator for content services.";

describe("PARSER_VERSION", () => {
  it("names the installed unpdf version", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "node_modules/unpdf/package.json"), "utf8")) as { version: string };
    expect(PARSER_VERSION).toBe(`unpdf@${pkg.version}+rules-1`);
  });
});

describe("extractPdfText", () => {
  it("extracts text page by page and preserves page boundaries", async () => {
    const pdf = makeTextPdf([
      ["Page one heading", longLine, "Agreement No: AGR-2025-001"],
      ["Second page text about payment terms and invoices in detail.", "Payment cycle: Monthly"],
      ["Third page (with) escapes \\ and parentheses in the body of the text."],
    ]);
    const result = await extractPdfText(pdf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageCount).toBe(3);
    expect(result.pages).toHaveLength(3);
    expect(result.pages[0]).toContain("Page one heading");
    expect(result.pages[0]).toContain("Agreement No: AGR-2025-001");
    expect(result.pages[0]).not.toContain("payment terms");
    expect(result.pages[1]).toContain("Payment cycle: Monthly");
    expect(result.pages[2]).toContain("Third page (with) escapes \\ and parentheses");
    expect(result.truncated.chars).toBe(false);
    // Lines stay on separate lines (extractors are line-anchored).
    expect(result.pages[0]!.split("\n").length).toBeGreaterThanOrEqual(3);
  });

  it("does not detach or mutate the caller's buffer", async () => {
    const pdf = makeTextPdf([[longLine, longLine]]);
    const bytes = new Uint8Array(pdf);
    await extractPdfText(bytes);
    expect(bytes.byteLength).toBe(pdf.byteLength);
    const again = await extractPdfText(bytes);
    expect(again.ok).toBe(true);
  });

  it("treats a valid PDF with no text (a scan stand-in) as no_extractable_text", async () => {
    expect(await extractPdfText(makeBlankPdf(3))).toEqual({ ok: false, reason: "no_extractable_text", pageCount: 3 });
  });

  it("treats a near-empty text layer (below the threshold) as no_extractable_text", async () => {
    const tiny = "x".repeat(MIN_EXTRACTABLE_CHARS - 1);
    expect(await extractPdfText(makeTextPdf([[tiny]]))).toMatchObject({ ok: false, reason: "no_extractable_text" });
    const enough = "x".repeat(MIN_EXTRACTABLE_CHARS);
    expect((await extractPdfText(makeTextPdf([[enough]]))).ok).toBe(true);
  });

  it("returns unreadable_pdf (never throws) for garbage, truncated and non-PDF input", async () => {
    for (const bytes of [makeGarbagePdf(), makeTruncatedPdf(makeTextPdf([[longLine, longLine]])), makeNotAPdf(), new Uint8Array(0)]) {
      const result = await extractPdfText(bytes);
      expect(result).toEqual({ ok: false, reason: "unreadable_pdf" });
    }
  });

  it("returns encrypted for a password-protected PDF", async () => {
    expect(await extractPdfText(makeEncryptedPdf())).toEqual({ ok: false, reason: "encrypted" });
  });

  it("rejects documents over the page bound instead of truncating them", async () => {
    const pages = Array.from({ length: 5 }, () => [longLine]);
    expect(await extractPdfText(makeTextPdf(pages), { maxPages: 4 })).toEqual({ ok: false, reason: "too_many_pages", pageCount: 5 });
    expect(MAX_PDF_PAGES).toBe(60);
    const atLimit = await extractPdfText(makeTextPdf(pages), { maxPages: 5 });
    expect(atLimit.ok).toBe(true);
  });

  it("caps total characters, flags truncation and keeps page indexes stable", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => [`Page ${i + 1} ${longLine}`, longLine]);
    const result = await extractPdfText(makeTextPdf(pages), { maxChars: 200 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated.chars).toBe(true);
    expect(result.pages).toHaveLength(4);
    expect(result.totalChars).toBeLessThanOrEqual(200);
    expect(result.pages[3]).toBe("");
  });
});

describe("normalizePageText", () => {
  it("collapses whitespace, strips control chars and keeps line structure", () => {
    expect(normalizePageText("  Name:\u00A0\u00A0Acme\t Ltd  \r\n\r\n\r\n\r\nPAN:\u0000 ABCDE1234F\u200B ")).toBe("Name: Acme Ltd\n\nPAN: ABCDE1234F");
  });
});
