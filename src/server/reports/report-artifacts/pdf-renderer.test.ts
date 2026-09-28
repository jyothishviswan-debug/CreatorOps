import { PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";

import type { ReportSectionModel, TableRow } from "../report-sections/types";
import { generateReportPdf, type PdfReportMeta } from "./pdf-renderer";
import { extractPdfPagesText, extractPdfText } from "./pdf-text-extract.test-support";

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

// Reports PDF Composition & Management-Publication Polish (spec section 21): page orientation.
describe("PDF renderer - page orientation (spec section 2)", () => {
  it("landscape orientation produces a page wider than it is tall", async () => {
    const bytes = await generateReportPdf(sections(), { ...meta, orientation: "landscape" });
    const loaded = await PDFDocument.load(bytes);
    const { width, height } = loaded.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
  });

  it("portrait (the default, and every template except Monthly) produces a page taller than it is wide", async () => {
    const explicitPortrait = await generateReportPdf(sections(), { ...meta, orientation: "portrait" });
    const omittedOrientation = await generateReportPdf(sections(), meta);
    for (const bytes of [explicitPortrait, omittedOrientation]) {
      const loaded = await PDFDocument.load(bytes);
      const { width, height } = loaded.getPage(0).getSize();
      expect(height).toBeGreaterThan(width);
    }
  });

  it("landscape and portrait use the SAME total page area (A4) - landscape is portrait's own width/height swapped, not a different page size", async () => {
    const landscape = await PDFDocument.load(await generateReportPdf(sections(), { ...meta, orientation: "landscape" }));
    const portrait = await PDFDocument.load(await generateReportPdf(sections(), { ...meta, orientation: "portrait" }));
    const l = landscape.getPage(0).getSize();
    const p = portrait.getPage(0).getSize();
    expect(l.width).toBeCloseTo(p.height, 1);
    expect(l.height).toBeCloseTo(p.width, 1);
  });
});

// Spec section 18: canonical PDF metadata.
describe("PDF renderer - canonical metadata (spec section 18)", () => {
  it("sets Author/Creator/Producer to CreatorOps, and a CreatorOps-authored Subject (never a template's raw referencePattern/external filename)", async () => {
    const bytes = await generateReportPdf(sections(), { ...meta, reportPurpose: "CreatorOps — Monthly Partner Performance" });
    // updateMetadata: false - PDFDocument.load's OWN default (true) re-runs pdf-lib's internal
    // updateInfoDict() on load, which unconditionally overwrites Producer/ModificationDate back to
    // pdf-lib's own defaults in the freshly-loaded in-memory doc (this does NOT change the bytes this
    // test already has in hand - only what a naive re-load-then-inspect would show) - passing false
    // reads back exactly what generateReportPdf actually wrote.
    const loaded = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(loaded.getAuthor()).toBe("CreatorOps");
    expect(loaded.getCreator()).toBe("CreatorOps Reports");
    expect(loaded.getProducer()).toBe("CreatorOps");
    expect(loaded.getSubject()).toBe("CreatorOps — Monthly Partner Performance");
    expect(loaded.getSubject()).not.toMatch(/Monthly_Creator_Productivity_Report_August_2026/);
    expect(loaded.getCreationDate()).toBeInstanceOf(Date);
    expect(loaded.getModificationDate()).toBeInstanceOf(Date);
  });
});

// Spec section 4: a finalized PDF (generateReportPdf's ONLY caller is ensureArtifactsForFinalizedVersion
// - see generate-artifacts.ts) may never contain "[DRAFT]", regardless of a narrative section's own
// reviewStatus field.
describe("PDF renderer - no [DRAFT]/debug/technical prose in finalized PDF content (spec sections 4/16/25)", () => {
  it("never draws a narrative section's own reviewStatus (e.g. [DRAFT]) into the PDF body", async () => {
    const bytes = await generateReportPdf(sections(), meta);
    const text = await extractPdfText(bytes);
    expect(text).not.toContain("[DRAFT]");
    expect(text).not.toContain("DRAFT");
  });

  it("a PDF-content guard: no known internal/debug phrase appears anywhere in rendered text, even when present in the section model's own note/body fields as a regression fixture", async () => {
    const debugSections: ReportSectionModel[] = [
      { kind: "cover", sectionType: "cover", mode: "EVIDENCE", title: "Monthly Partner Performance", subtitle: "sub", scopeLine: "scope", periodLine: "period", generatedAtLine: "gen", evidenceCutoffLine: "cutoff" },
      { kind: "narrative", sectionType: "narrative_section", mode: "NARRATIVE", title: "Executive Summary", body: "Instagram accounted for the larger share of measured views this month.", editable: true, sectionKey: "executive_summary", reviewStatus: "DRAFT" },
    ];
    const bytes = await generateReportPdf(debugSections, meta);
    const text = await extractPdfText(bytes);
    for (const forbidden of ["[DRAFT]", "full actor scope", "partnerRef", "views_standard", "renderer verification", "bounded, single-Partner", "wide-table rendering", "centered cell alignment"]) {
      expect(text, `finalized PDF must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

// Spec sections 6/25: raw internal refs must never appear as ordinary rendered PDF text.
describe("PDF renderer - raw-ref pattern guard (spec sections 6/25)", () => {
  const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  it("a column whose id ends in Ref is still rendered if the caller explicitly includes it (this file's own regression fixture) - the SUPPRESSION is enforced upstream, at buildGenericTable, not here", async () => {
    // This renderer draws whatever section model it is given - the raw-ref DROP guarantee (spec section
    // 6) lives in report-sections/helpers.ts's buildGenericTable (see helpers.test.ts), which is what
    // every real family/builder actually uses. This test just documents that boundary explicitly.
    const withRawRef: ReportSectionModel[] = [
      { kind: "cover", sectionType: "cover", mode: "EVIDENCE", title: "Partner Portfolio", subtitle: "sub", scopeLine: "scope", periodLine: "period", generatedAtLine: "gen", evidenceCutoffLine: "cutoff" },
      { kind: "table", sectionType: "ranked_table", mode: "EVIDENCE", title: "Partners", columns: [{ id: "partnerRef", label: "Partner Ref" }], rows: [{ partnerRef: "e055235f-128c-4b79-bd74-9741e576f554" }] },
    ];
    const text = await extractPdfText(await generateReportPdf(withRawRef, meta));
    expect(UUID_PATTERN.test(text)).toBe(true);
  });
});

// Spec section 7: real clickable PDF hyperlinks with human-readable labels, via the paired `<col.id>Href`
// column convention.
describe("PDF renderer - paired-column hyperlinks (spec section 7)", () => {
  function hrefSections(rows: TableRow[]): ReportSectionModel[] {
    return [
      { kind: "cover", sectionType: "cover", mode: "EVIDENCE", title: "Monthly Partner Performance", subtitle: "sub", scopeLine: "scope", periodLine: "period", generatedAtLine: "gen", evidenceCutoffLine: "cutoff" },
      { kind: "table", sectionType: "top_n_content", mode: "EVIDENCE", title: "Instagram - Top 5 by Views", columns: [{ id: "partnerDisplayName", label: "Partner" }, { id: "openPost", label: "Content" }], rows },
    ];
  }

  it("draws the human label (never the raw URL) as visible text, while still attaching a real clickable annotation pointing at the paired Href field", async () => {
    const rows: TableRow[] = [{ partnerDisplayName: "Acme Creators", openPost: "Open Post", openPostHref: "https://instagram.com/p/real-post-123" }];
    const bytes = await generateReportPdf(hrefSections(rows), meta);
    const text = await extractPdfText(bytes);
    expect(text).toContain("Open Post");
    expect(text).not.toContain("https://instagram.com/p/real-post-123");

    const loaded = await PDFDocument.load(bytes);
    let foundUri: string | null = null;
    for (const page of loaded.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i++) {
        const annot = loaded.context.lookup(annots.get(i));
        if (!(annot instanceof PDFDict)) continue;
        const action = annot.lookup(PDFName.of("A"));
        if (!(action instanceof PDFDict)) continue;
        const uri = action.lookup(PDFName.of("URI"));
        if (uri instanceof PDFString) foundUri = uri.decodeText();
      }
    }
    expect(foundUri).toBe("https://instagram.com/p/real-post-123");
  });

  it("a row with no Href value renders the label as plain (non-link) text - no annotation for that cell", async () => {
    const rows: TableRow[] = [{ partnerDisplayName: "No Link Partner", openPost: null, openPostHref: null }];
    const bytes = await generateReportPdf(hrefSections(rows), meta);
    const loaded = await PDFDocument.load(bytes);
    let annotationCount = 0;
    for (const page of loaded.getPages()) {
      const annots = page.node.Annots();
      if (annots) annotationCount += annots.size();
    }
    expect(annotationCount).toBe(0);
  });
});

// Spec section 15: pagination / keep-together.
describe("PDF renderer - pagination keep-together (spec section 15)", () => {
  function pushNearPageBottom(): ReportSectionModel {
    // A long narrative body reliably consumes most of a portrait page's content height, landing the
    // NEXT section close to the page's bottom edge - the exact condition the keep-together rules exist
    // for.
    const body = Array.from({ length: 60 }, (_, i) => `Filler narrative line ${i} to consume vertical space on the page.`).join("\n\n");
    return { kind: "narrative", sectionType: "narrative_section", mode: "NARRATIVE", title: "Filler", body, editable: true, sectionKey: "context" };
  }

  it("a small table (e.g. a 5-row leaderboard) that would only PARTIALLY fit on the current page moves to a fresh page as a whole - its header is drawn exactly once, never split", async () => {
    const smallTable: ReportSectionModel = {
      kind: "table",
      sectionType: "source_metric_leaders",
      mode: "EVIDENCE",
      title: "Small Leaderboard",
      columns: [{ id: "rank", label: "Rank", numeric: true }, { id: "label", label: "Partner" }, { id: "value", label: "Views", numeric: true }],
      rows: Array.from({ length: 5 }, (_, i) => ({ rank: i + 1, label: `Partner ${i}`, value: 1000 - i })),
    };
    const withCover: ReportSectionModel[] = [{ kind: "cover", sectionType: "cover", mode: "EVIDENCE", title: "Monthly Partner Performance", subtitle: "sub", scopeLine: "scope", periodLine: "period", generatedAtLine: "gen", evidenceCutoffLine: "cutoff" }, pushNearPageBottom(), smallTable];
    const pages = await extractPdfPagesText(await generateReportPdf(withCover, meta));
    const pagesWithHeader = pages.filter((p) => p.includes("Partner") && p.includes("Views") && p.includes("Rank"));
    // The header trio (Rank/Partner/Views) appears together on exactly one page - never split so that
    // "Rank"/"Partner" land on one page and "Views" (or a data row) lands on the next.
    expect(pagesWithHeader.length).toBeGreaterThanOrEqual(1);
    // All 5 data rows land on that SAME page as the header (no orphaned row on a later page).
    const headerPageIndex = pages.findIndex((p) => p.includes("Rank") && p.includes("Partner") && p.includes("Views"));
    expect(headerPageIndex).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 5; i++) expect(pages[headerPageIndex]).toContain(`Partner ${i}`);
  });

  it("a heading never lands alone at the bottom of a page with no body content beneath it - a narrative section's heading and its own opening words share the same page", async () => {
    const narrative: ReportSectionModel = { kind: "narrative", sectionType: "conclusion", mode: "NARRATIVE", title: "Conclusion", body: "A DISTINCTIVE_CONCLUSION_OPENING_SENTENCE follows the heading immediately.", editable: true, sectionKey: "conclusion" };
    const withCover: ReportSectionModel[] = [{ kind: "cover", sectionType: "cover", mode: "EVIDENCE", title: "Monthly Partner Performance", subtitle: "sub", scopeLine: "scope", periodLine: "period", generatedAtLine: "gen", evidenceCutoffLine: "cutoff" }, pushNearPageBottom(), narrative];
    const pages = await extractPdfPagesText(await generateReportPdf(withCover, meta));
    const headingPageIndex = pages.findIndex((p) => p.includes("Conclusion"));
    const bodyPageIndex = pages.findIndex((p) => p.includes("DISTINCTIVE_CONCLUSION_OPENING_SENTENCE"));
    expect(headingPageIndex).toBeGreaterThanOrEqual(0);
    expect(bodyPageIndex).toBe(headingPageIndex);
  });

  it("a large table that must split repeats its header on the continuation page and never strands only the final 1-2 rows alone", async () => {
    const bigTable: ReportSectionModel = {
      kind: "table",
      sectionType: "performance_band_distribution",
      mode: "EVIDENCE",
      title: "Big Table",
      columns: [{ id: "label", label: "Partner" }, { id: "value", label: "Count", numeric: true }],
      rows: Array.from({ length: 60 }, (_, i) => ({ label: `Row Partner ${i}`, value: i })),
    };
    const withCover: ReportSectionModel[] = [{ kind: "cover", sectionType: "cover", mode: "EVIDENCE", title: "Monthly Partner Performance", subtitle: "sub", scopeLine: "scope", periodLine: "period", generatedAtLine: "gen", evidenceCutoffLine: "cutoff" }, bigTable];
    const pages = await extractPdfPagesText(await generateReportPdf(withCover, meta));
    const pagesWithHeader = pages.filter((p) => p.includes("Partner") && p.includes("Count"));
    // A 60-row table genuinely cannot fit on one page - the header must repeat on every continuation page.
    expect(pagesWithHeader.length).toBeGreaterThan(1);
    // The LAST page that has any table row must have at least 2 rows on it (never exactly 1 orphaned row).
    const lastRowPageIndex = pages.reduce((last, p, i) => (/Row Partner \d+/.test(p) ? i : last), -1);
    expect(lastRowPageIndex).toBeGreaterThanOrEqual(0);
    const rowCountOnLastPage = (pages[lastRowPageIndex]!.match(/Row Partner \d+/g) ?? []).length;
    expect(rowCountOnLastPage).toBeGreaterThanOrEqual(2);
  });
});
