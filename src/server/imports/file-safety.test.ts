import { describe, expect, it } from "vitest";

import { checkImportFileSafety, MAX_IMPORT_FILE_BYTES } from "./file-safety";

function bufferOf(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

describe("checkImportFileSafety", () => {
  it("accepts a plausible .xlsx upload within size limits", () => {
    const result = checkImportFileSafety({
      filename: "export.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 1000,
      buffer: bufferOf("PK-fake-zip-content"),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an empty file", () => {
    const result = checkImportFileSafety({ filename: "export.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 0, buffer: Buffer.alloc(0) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("EMPTY_FILE");
  });

  it("rejects a file over the configured size limit", () => {
    const result = checkImportFileSafety({
      filename: "export.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: MAX_IMPORT_FILE_BYTES + 1,
      buffer: bufferOf("x"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("FILE_TOO_LARGE");
  });

  it("rejects a macro-enabled workbook extension outright, before any parsing", () => {
    const xlsm = checkImportFileSafety({ filename: "export.xlsm", mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12", sizeBytes: 100, buffer: bufferOf("x") });
    expect(xlsm.ok).toBe(false);
    if (!xlsm.ok) expect(xlsm.reasonCode).toBe("MACRO_WORKBOOK_REJECTED");

    const xlsb = checkImportFileSafety({ filename: "export.xlsb", mimeType: "application/vnd.ms-excel.sheet.binary.macroEnabled.12", sizeBytes: 100, buffer: bufferOf("x") });
    expect(xlsb.ok).toBe(false);
    if (!xlsb.ok) expect(xlsb.reasonCode).toBe("MACRO_WORKBOOK_REJECTED");
  });

  it("rejects an unsupported extension", () => {
    const result = checkImportFileSafety({ filename: "export.pdf", mimeType: "application/pdf", sizeBytes: 100, buffer: bufferOf("x") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("UNSUPPORTED_EXTENSION");
  });

  it("rejects a file whose raw bytes contain a vbaProject.bin part, even under an accepted extension", () => {
    const result = checkImportFileSafety({
      filename: "export.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 100,
      buffer: bufferOf("PK...xl/vbaProject.bin...more zip bytes"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("MACRO_CONTENT_DETECTED");
  });
});
