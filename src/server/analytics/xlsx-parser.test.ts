import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { parseWorkbookBuffer } from "./xlsx-parser";

function bufferFromRows(sheetName: string, rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("parseWorkbookBuffer", () => {
  it("parses a real workbook's headers and data rows, values only (never a formula string)", () => {
    const buffer = bufferFromRows("Posts", [
      ["Post ID", "Post URL", "Comments"],
      ["p1", "https://instagram.com/p/p1", 12],
      ["p2", "https://instagram.com/p/p2", 34],
    ]);
    const result = parseWorkbookBuffer(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0]!.headers).toEqual(["Post ID", "Post URL", "Comments"]);
    expect(result.sheets[0]!.rows).toHaveLength(2);
    expect(result.sheets[0]!.rows[0]).toMatchObject({ "Post ID": "p1", Comments: 12 });
  });

  it("a blank cell becomes null, never an empty string or 0", () => {
    const buffer = bufferFromRows("Posts", [
      ["Post ID", "Comments"],
      ["p1", null],
    ]);
    const result = parseWorkbookBuffer(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sheets[0]!.rows[0]!.Comments).toBeNull();
  });

  it("never trusts a cell's formula - reads only its cached value", () => {
    const workbook = XLSX.utils.book_new();
    const sheet: XLSX.WorkSheet = {
      A1: { t: "s", v: "Comments" },
      A2: { t: "n", v: 99, f: "=1/0" }, // a malicious/broken formula string - the cached value must win
      "!ref": "A1:A2",
    };
    XLSX.utils.book_append_sheet(workbook, sheet, "Posts");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const result = parseWorkbookBuffer(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sheets[0]!.rows[0]!.Comments).toBe(99);
  });

  it("rejects a corrupt zip-like buffer instead of throwing", () => {
    // A truncated/corrupt ZIP (the .xlsx container format) - the library
    // sniffs the "PK" magic bytes, attempts to unzip, and fails; a plain
    // text buffer is deliberately NOT used here since XLSX.read's own
    // lenient CSV-sniffing fallback would otherwise parse it as a valid
    // one-cell sheet, which is real (if surprising) library behavior,
    // not a bug in this wrapper - file-safety.ts's own extension/MIME
    // checks are what actually keep a non-spreadsheet file out before
    // this parser ever runs.
    const result = parseWorkbookBuffer(Buffer.from("PK\x03\x04this is not a valid zip stream", "binary"));
    expect(result.ok).toBe(false);
  });
});
