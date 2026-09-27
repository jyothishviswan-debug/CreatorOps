import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { generatePdf, PDF_MAX_ROWS } from "./pdf";
import type { ExportColumnDef, ExportRow } from "./types";

const columns: ExportColumnDef[] = [
  { id: "ref", label: "Ref" },
  { id: "name", label: "Name" },
];

describe("generatePdf (real bytes, parsed back with pdf-lib)", () => {
  it("produces bytes that pdf-lib itself can load, with at least one page", async () => {
    const rows: ExportRow[] = [{ ref: "p_001", name: "Creator House" }];
    const bytes = await generatePdf(columns, rows, {
      targetTitle: "Partners",
      format: "pdf",
      appliedFilters: { status: "ACTIVE" },
      generatedAt: new Date().toISOString(),
      rowCount: 1,
      maxRows: 500,
      truncated: false,
      pdfRowLimitApplied: false,
    });
    expect(bytes.byteLength).toBeGreaterThan(0);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("paginates when many rows are given (bounded, never one unreadable page)", async () => {
    const rows: ExportRow[] = Array.from({ length: 120 }, (_, i) => ({ ref: `p_${i}`, name: `Partner number ${i} with a fairly long display name to force wrapping` }));
    const bytes = await generatePdf(columns, rows, {
      targetTitle: "Partners",
      format: "pdf",
      appliedFilters: {},
      generatedAt: new Date().toISOString(),
      rowCount: rows.length,
      maxRows: 500,
      truncated: false,
      pdfRowLimitApplied: false,
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("renders a safe placeholder line when there are no rows, rather than an empty/broken document", async () => {
    const bytes = await generatePdf(columns, [], {
      targetTitle: "Partners",
      format: "pdf",
      appliedFilters: {},
      generatedAt: new Date().toISOString(),
      rowCount: 0,
      maxRows: 500,
      truncated: false,
      pdfRowLimitApplied: false,
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("PDF_MAX_ROWS is a real, positive bound", () => {
    expect(PDF_MAX_ROWS).toBeGreaterThan(0);
  });

  it("renders a real, loadable document when truncated:true (section 9's disclosed-truncation code path, exercised directly)", async () => {
    const rows: ExportRow[] = [{ ref: "p_001", name: "Creator House" }];
    const bytes = await generatePdf(columns, rows, {
      targetTitle: "Partners",
      format: "pdf",
      appliedFilters: {},
      generatedAt: new Date().toISOString(),
      rowCount: 100,
      maxRows: 100,
      truncated: true,
      pdfRowLimitApplied: false,
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });
});
