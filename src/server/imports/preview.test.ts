import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { previewImportFile } from "./preview";

function bufferFromRows(sheetName: string, rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("previewImportFile", () => {
  it("returns bounded sample rows, row count, and headers for a valid workbook", () => {
    const rows: unknown[][] = [["Post ID", "Comments"]];
    for (let i = 0; i < 15; i++) rows.push([`p${i}`, i]);
    const buffer = bufferFromRows("Posts", rows);

    const result = previewImportFile({ filename: "posts.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0]!.headers).toEqual(["Post ID", "Comments"]);
    expect(result.sheets[0]!.rowCount).toBe(15);
    // Never thousands of rows to the browser - bounded sample.
    expect(result.sheets[0]!.sampleRows.length).toBeLessThanOrEqual(10);
    expect(result.sheets[0]!.sampleRowsTruncated).toBe(true);
  });

  it("detects a duplicate header", () => {
    const buffer = bufferFromRows("Posts", [
      ["Post ID", "post id"],
      ["p1", "p1"],
    ]);
    const result = previewImportFile({ filename: "posts.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sheets[0]!.duplicateHeaders).toContain("post id");
    expect(result.warnings.some((w) => w.includes("duplicate column header"))).toBe(true);
  });

  it("detects trailing blank rows", () => {
    const buffer = bufferFromRows("Posts", [
      ["Post ID"],
      ["p1"],
      [null],
      [null],
    ]);
    const result = previewImportFile({ filename: "posts.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sheets[0]!.trailingEmptyRowCount).toBe(2);
  });

  it("rejects an oversized file with a classified FILE-level error, never a raw exception", () => {
    const result = previewImportFile({ filename: "posts.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.alloc(11 * 1024 * 1024) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("FILE");
    expect(result.error.code).toBe("FILE_TOO_LARGE");
  });

  it("rejects an unsupported extension before ever parsing", () => {
    const result = previewImportFile({ filename: "posts.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a spreadsheet") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED_EXTENSION");
  });
});
