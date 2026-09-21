import { describe, expect, it } from "vitest";

import { MAX_CONTRACT_PDF_BYTES, PDF_HEADER_WINDOW_BYTES, sha256Hex, validateContractPdf } from "./validation";

function pdfOfSize(size: number, header = "%PDF-1.4\n"): Uint8Array {
  const bytes = new Uint8Array(size);
  const head = new TextEncoder().encode(header);
  bytes.set(head.subarray(0, Math.min(head.length, size)), 0);
  return bytes;
}

describe("validateContractPdf", () => {
  it("accepts a small valid header", () => {
    expect(validateContractPdf(pdfOfSize(200))).toEqual({ ok: true, sizeBytes: 200 });
  });

  it("rejects empty input", () => {
    expect(validateContractPdf(new Uint8Array(0))).toEqual({ ok: false, reason: "empty" });
  });

  it("accepts exactly 10 MB and rejects 10 MB + 1 byte", () => {
    expect(MAX_CONTRACT_PDF_BYTES).toBe(10 * 1024 * 1024);
    expect(validateContractPdf(pdfOfSize(MAX_CONTRACT_PDF_BYTES)).ok).toBe(true);
    expect(validateContractPdf(pdfOfSize(MAX_CONTRACT_PDF_BYTES + 1))).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects non-PDF bytes and text files", () => {
    expect(validateContractPdf(new TextEncoder().encode("hello world, not a pdf at all"))).toEqual({ ok: false, reason: "not_a_pdf" });
    expect(validateContractPdf(new TextEncoder().encode("<html>%PDF</html>"))).toEqual({ ok: false, reason: "not_a_pdf" });
  });

  it("finds the magic within the first 1024 bytes but not beyond", () => {
    const within = new Uint8Array(PDF_HEADER_WINDOW_BYTES + 50);
    within.set(new TextEncoder().encode("%PDF-1.7"), PDF_HEADER_WINDOW_BYTES - 8);
    expect(validateContractPdf(within).ok).toBe(true);

    const beyond = new Uint8Array(PDF_HEADER_WINDOW_BYTES + 50);
    beyond.set(new TextEncoder().encode("%PDF-1.7"), PDF_HEADER_WINDOW_BYTES);
    expect(validateContractPdf(beyond)).toEqual({ ok: false, reason: "not_a_pdf" });
  });

  it("rejects a magic without a sane version", () => {
    expect(validateContractPdf(pdfOfSize(64, "%PDF-x.y"))).toEqual({ ok: false, reason: "invalid_header" });
    expect(validateContractPdf(pdfOfSize(64, "%PDF-9.9"))).toEqual({ ok: false, reason: "invalid_header" });
    expect(validateContractPdf(new TextEncoder().encode("%PDF-"))).toEqual({ ok: false, reason: "invalid_header" });
  });

  it("accepts PDF 2.0 headers", () => {
    expect(validateContractPdf(pdfOfSize(64, "%PDF-2.0\n")).ok).toBe(true);
  });
});

describe("sha256Hex", () => {
  it("hashes deterministically", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
