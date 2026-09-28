import { describe, expect, it } from "vitest";

import { checkImportFileSafety, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ZIP_ENTRIES, MAX_IMPORT_ZIP_ENTRY_UNCOMPRESSED_BYTES, MAX_IMPORT_ZIP_TOTAL_UNCOMPRESSED_BYTES } from "./file-safety";

function bufferOf(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

// ---- Minimal, structurally-real ZIP fixture builder (base spec section 13's own "decompression-
// bomb fixture" requirement) - builds only the End Of Central Directory + central directory records
// preflightZipStructure actually reads, with arbitrary DECLARED compressed/uncompressed sizes. Real
// entry bytes/compression are never needed: the whole point of the defense under test is that it
// classifies purely from the ZIP container's own declared metadata, without decompressing anything.
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}
function centralDirRecord(name: string, compressedSize: number, uncompressedSize: number): Buffer {
  const nameBuf = Buffer.from(name, "ascii");
  return Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(compressedSize),
    u32(uncompressedSize),
    u16(nameBuf.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    nameBuf,
  ]);
}
function buildFakeZip(entries: { name: string; compressedSize: number; uncompressedSize: number }[]): Buffer {
  // A real 4-byte local-file-header signature so the "is this even a ZIP" sniff fires, immediately
  // followed by the central directory (no real per-entry local headers/data needed - the preflight
  // never reads past what the EOCD points it at).
  const localHeaderSignature = u32(0x04034b50);
  const centralDir = Buffer.concat(entries.map((e) => centralDirRecord(e.name, e.compressedSize, e.uncompressedSize)));
  const centralDirOffset = localHeaderSignature.length;
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralDir.length), u32(centralDirOffset), u16(0)]);
  return Buffer.concat([localHeaderSignature, centralDir, eocd]);
}
function checkZip(buffer: Buffer) {
  return checkImportFileSafety({ filename: "import.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: buffer.byteLength, buffer });
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

  // Production hardening (base spec section 13/40): the pre-parse ZIP-container decompression-bomb
  // defense - fires from the container's own declared structure, before XLSX.read() ever runs.
  describe("preflightZipStructure (decompression-bomb / oversized-container defense)", () => {
    it("accepts a real ZIP structure with ordinary, small declared sizes", () => {
      const zip = buildFakeZip([
        { name: "[Content_Types].xml", compressedSize: 200, uncompressedSize: 600 },
        { name: "xl/worksheets/sheet1.xml", compressedSize: 1000, uncompressedSize: 8000 },
        { name: "xl/sharedStrings.xml", compressedSize: 500, uncompressedSize: 3000 },
      ]);
      expect(checkZip(zip).ok).toBe(true);
    });

    it("rejects a single entry whose declared uncompressed size exceeds the per-entry cap", () => {
      const zip = buildFakeZip([{ name: "xl/worksheets/sheet1.xml", compressedSize: 1000, uncompressedSize: MAX_IMPORT_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1 }]);
      const result = checkZip(zip);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe("ZIP_ENTRY_TOO_LARGE");
    });

    it("rejects a classic decompression-bomb ratio: a tiny compressed size claiming a huge (but individually-under-cap) uncompressed size", () => {
      // 100 bytes compressed -> 50 MB declared uncompressed is a ~524,000:1 ratio, nowhere near a
      // real workbook's typical single- to low-double-digit DEFLATE ratio for XML/text - and the 50
      // MB itself stays under MAX_IMPORT_ZIP_ENTRY_UNCOMPRESSED_BYTES, isolating the ratio check
      // from the separate absolute per-entry-size check above.
      const zip = buildFakeZip([{ name: "xl/sharedStrings.xml", compressedSize: 100, uncompressedSize: 50 * 1024 * 1024 }]);
      const result = checkZip(zip);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe("SUSPICIOUS_COMPRESSION_RATIO");
    });

    it("rejects when the TOTAL declared uncompressed size across many under-the-per-entry-cap, under-the-ratio-cap entries still exceeds the total cap", () => {
      const perEntry = 5 * 1024 * 1024; // 5 MB each, well under the per-entry cap
      // ~250:1 per entry - comfortably under the 300:1 ratio cap on its own, isolating the TOTAL
      // check from the per-entry ratio check above.
      const compressedSize = Math.ceil(perEntry / 250);
      const entryCount = Math.min(Math.ceil(MAX_IMPORT_ZIP_TOTAL_UNCOMPRESSED_BYTES / perEntry) + 1, MAX_IMPORT_ZIP_ENTRIES);
      const entries = Array.from({ length: entryCount }, (_, i) => ({ name: `xl/worksheets/sheet${i}.xml`, compressedSize, uncompressedSize: perEntry }));
      const zip = buildFakeZip(entries);
      const result = checkZip(zip);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe("DECOMPRESSION_LIMIT_EXCEEDED");
    });

    it("rejects a ZIP container declaring more entries than the entry-count limit", () => {
      const entries = Array.from({ length: MAX_IMPORT_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `part${i}.xml`, compressedSize: 10, uncompressedSize: 10 }));
      const zip = buildFakeZip(entries);
      const result = checkZip(zip);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe("TOO_MANY_ZIP_ENTRIES");
    });

    it("rejects a malformed/truncated ZIP structure safely, without crashing", () => {
      // Real local-file signature, but no valid EOCD anywhere in the buffer.
      const truncated = Buffer.concat([u32(0x04034b50), Buffer.from("not a real central directory or EOCD record at all, just junk bytes padding this out past the EOCD search window enough to prove no false match")]);
      const result = checkZip(truncated);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe("MALFORMED_ZIP_CONTAINER");
    });

    it("is a no-op for a non-ZIP buffer (e.g. a .csv or a non-conforming .xls upload) - never false-positives on an unrelated format", () => {
      const csvLike = bufferOf("name,region\nAlpha,Kerala\n");
      const result = checkImportFileSafety({ filename: "import.csv", mimeType: "text/csv", sizeBytes: csvLike.byteLength, buffer: csvLike });
      expect(result.ok).toBe(true);
    });
  });
});
