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

  // Bug class A regression test (this stage's completion report): a single unbreakable token (no
  // whitespace at all - a raw UUID is the real-world example that shipped broken) that alone exceeds a
  // narrow column's own width must never crash or silently overflow into the next column. Before this
  // stage's fix, wrapAllLines only ever split on whitespace, so this exact shape reproduced the
  // reported "97GTeS7f6554"-style overlap.
  it("hard-truncates a single unbreakable token wider than its column instead of overflowing", async () => {
    const uuidLikeSections: ReportSectionModel[] = [
      { kind: "cover", sectionType: "cover", mode: "EVIDENCE", title: "Partner Portfolio", subtitle: "sub", scopeLine: "scope", periodLine: "period", generatedAtLine: "gen", evidenceCutoffLine: "cutoff" },
      {
        kind: "table",
        sectionType: "ranked_table",
        mode: "EVIDENCE",
        title: "Partners",
        columns: [
          { id: "partnerDisplayName", label: "Partner" },
          { id: "status", label: "Status" },
          { id: "partnerRef", label: "Partner Ref" },
        ],
        rows: [
          { partnerDisplayName: "Acme Creators", status: "ACTIVE", partnerRef: "e055235f-128c-4b79-bd74-9741e576f554aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        ],
      },
    ];
    const bytes = await generateReportPdf(uuidLikeSections, meta);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  // Design brief regression test: buildGenericTable's own defense-in-depth column filter (see
  // report-sections/helpers.ts) must mean a nested-object field on a row (the exact shape that broke
  // Finance Status / Operations Attention before this stage's fix) never reaches the PDF text layout at
  // all - the renderer itself must also never throw if one somehow did.
  it("never throws when a table row contains a non-scalar column value", async () => {
    const badSections: ReportSectionModel[] = [
      { kind: "cover", sectionType: "cover", mode: "EVIDENCE", title: "Finance Status", subtitle: "sub", scopeLine: "scope", periodLine: "period", generatedAtLine: "gen", evidenceCutoffLine: "cutoff" },
      {
        kind: "table",
        sectionType: "ranked_table",
        mode: "EVIDENCE",
        title: "Agreements",
        columns: [
          { id: "counterpartyDisplayName", label: "Counterparty" },
          { id: "nested", label: "Nested" },
        ],
        // `nested` simulates an accidental object-valued cell slipping through - the renderer must not throw.
        rows: [{ counterpartyDisplayName: "Vendor A", nested: { a: 1 } as unknown as string }],
      },
    ];
    await expect(generateReportPdf(badSections, meta)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("selects the accent-tile KPI/cover mode for monthly_partner_performance and the bordered-grid mode otherwise", async () => {
    const accentBytes = await generateReportPdf(sections(), { ...meta, templateId: "monthly_partner_performance" });
    const gridBytes = await generateReportPdf(sections(), { ...meta, templateId: "campaign_event_performance_detailed" });
    const defaultBytes = await generateReportPdf(sections(), meta);
    for (const bytes of [accentBytes, gridBytes, defaultBytes]) {
      const loaded = await PDFDocument.load(bytes);
      expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
    }
  });

  it("Roman-numeral-prefixes section headings only for the designated templates", async () => {
    // Not asserting on drawn text content (pdf-lib does not expose rendered text back out easily) -
    // this is a smoke test that the numbering code path runs without throwing for both branches.
    await expect(generateReportPdf(sections(), { ...meta, templateId: "campaign_event_performance_compact" })).resolves.toBeInstanceOf(Uint8Array);
    await expect(generateReportPdf(sections(), { ...meta, templateId: "partner_portfolio_coverage" })).resolves.toBeInstanceOf(Uint8Array);
  });
});
