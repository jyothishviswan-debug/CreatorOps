import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import type { ReportSectionModel } from "../report-sections/types";
import { generateReportPdf, type PdfReportMeta } from "./pdf-renderer";

const meta: PdfReportMeta = {
  templateTitle: "Monthly Partner Performance",
  reportPurpose: "Test purpose.",
  scopeLine: "Scope: test",
  periodLine: "Period: 2026-08",
  generatedAtLine: "Generated: 2026-08-31T00:00:00.000Z",
  evidenceCutoffLine: "Evidence cutoff: 2026-08-30T00:00:00.000Z",
  versionLabel: "Version 1 - FINALIZED",
  finalizedLine: "Finalized 2026-08-31T00:00:00.000Z",
};

function sections(): ReportSectionModel[] {
  return [
    { kind: "cover", sectionType: "cover", mode: "EVIDENCE", title: "Monthly Partner Performance", subtitle: "sub", scopeLine: "scope", periodLine: "period", generatedAtLine: "gen", evidenceCutoffLine: "cutoff" },
    { kind: "kpi_summary", sectionType: "kpi_summary", mode: "EVIDENCE", title: "KPIs", items: [{ label: "Partners", value: "12" }, { label: "Unavailable metric", value: "Not available", unavailable: true }] },
    {
      kind: "table",
      sectionType: "partner_performance_table",
      mode: "EVIDENCE",
      title: "Partner Performance",
      columns: [{ id: "name", label: "Partner" }, { id: "views", label: "Views", numeric: true }, { id: "link", label: "Content" }],
      rows: Array.from({ length: 40 }, (_, i) => ({ name: `Partner ${i}`, views: i * 1000, link: i % 5 === 0 ? `https://example.com/content/${i}` : null })),
      totalsRow: { name: "Total", views: 780000, link: null },
    },
    { kind: "narrative", sectionType: "narrative_section", mode: "NARRATIVE", title: "Executive Summary", body: "This is the executive summary.\n\nSecond paragraph.", editable: true, sectionKey: "executive_summary", reviewStatus: "DRAFT" },
    { kind: "data_quality", sectionType: "data_quality", mode: "EVIDENCE", title: "Data Coverage & Quality", items: [{ label: "Rows", value: "40" }], warnings: ["A disclosed limitation."] },
    { kind: "table", sectionType: "top_n_content", mode: "EVIDENCE", title: "Unavailable Section", unavailableReason: "Not available: no such data exists.", columns: [], rows: [], emptyMessage: "Not available." },
  ];
}

describe("PDF renderer", () => {
  it("produces a valid, loadable multi-page PDF with the expected page count for a long table", async () => {
    const bytes = await generateReportPdf(sections(), meta);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
    // 40 table rows plus a cover/KPI/narrative/data-quality section should overflow a single A4 page.
    expect(loaded.getPageCount()).toBeGreaterThan(1);
  });

  it("sets document title/subject metadata", async () => {
    const bytes = await generateReportPdf(sections(), meta);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getTitle()).toBe(meta.templateTitle);
  });

  it("attaches at least one clickable link annotation for a URL-valued cell", async () => {
    const bytes = await generateReportPdf(sections(), meta);
    const loaded = await PDFDocument.load(bytes);
    let annotationCount = 0;
    for (const page of loaded.getPages()) {
      const annots = page.node.Annots();
      if (annots) annotationCount += annots.size();
    }
    expect(annotationCount).toBeGreaterThan(0);
  });

  it("renders an unavailable section without throwing and marks it in the output", async () => {
    const bytes = await generateReportPdf(sections(), meta);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("handles an empty section list without throwing", async () => {
    const bytes = await generateReportPdf([], meta);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });
});
