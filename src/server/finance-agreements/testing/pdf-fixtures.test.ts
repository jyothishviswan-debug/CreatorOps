import { describe, expect, it } from "vitest";

import { validateContractPdf } from "../contract-artifacts/validation";
import { extractPdfText } from "../extraction/pdf-text";
import { makeBlankPdf, makeEncryptedPdf, makeGarbagePdf, makeNotAPdf, makeTextPdf, makeTruncatedPdf } from "./pdf-fixtures";

function latin1(buffer: Buffer): string {
  return buffer.toString("latin1");
}

describe("makeTextPdf / makeBlankPdf structure", () => {
  it("builds a PDF whose xref offsets point at the objects they name", () => {
    const pdf = makeTextPdf([["Page one"], ["Page two"], ["Page three"]]);
    const text = latin1(pdf);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) \d{5} n $/gm)].map((m) => Number(m[1]));
    // catalog + pages + font + 3 x (page + content)
    expect(entries).toHaveLength(9);
    entries.forEach((offset, index) => expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`));
    expect(validateContractPdf(pdf)).toMatchObject({ ok: true });
  });

  it("escapes parentheses and backslashes and replaces characters Helvetica cannot encode", async () => {
    const pdf = makeTextPdf([["Escapes ) ( \\ and a rupee ₹ sign to be replaced, padded so it is long enough"]]);
    const result = await extractPdfText(pdf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages[0]).toContain("Escapes ) ( \\ and a rupee ? sign");
  });

  it("rejects degenerate inputs", () => {
    expect(() => makeTextPdf([])).toThrow();
    expect(() => makeBlankPdf(0)).toThrow();
  });
});

describe("blank, encrypted and garbage helpers behave as their stand-ins claim", () => {
  it("blank PDFs are valid PDFs with pages but no text", async () => {
    const pdf = makeBlankPdf(2);
    expect(validateContractPdf(pdf).ok).toBe(true);
    expect(await extractPdfText(pdf)).toEqual({ ok: false, reason: "no_extractable_text", pageCount: 2 });
  });

  it("encrypted, garbage, truncated and non-pdf fixtures never throw and map to safe reasons", async () => {
    expect(await extractPdfText(makeEncryptedPdf())).toEqual({ ok: false, reason: "encrypted" });
    expect(await extractPdfText(makeGarbagePdf())).toEqual({ ok: false, reason: "unreadable_pdf" });
    expect(await extractPdfText(makeTruncatedPdf())).toEqual({ ok: false, reason: "unreadable_pdf" });
    expect(await extractPdfText(makeNotAPdf())).toEqual({ ok: false, reason: "unreadable_pdf" });
    // The garbage/truncated ones DO pass the upload magic check: the parser is the second line of defence.
    expect(validateContractPdf(makeGarbagePdf()).ok).toBe(true);
    expect(validateContractPdf(makeTruncatedPdf()).ok).toBe(true);
    expect(validateContractPdf(makeNotAPdf())).toEqual({ ok: false, reason: "not_a_pdf" });
  });
});
