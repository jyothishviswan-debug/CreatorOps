import { PDFArray, PDFDocument, PDFFont, PDFName, PDFPage, PDFRef, PDFString, StandardFonts, rgb } from "pdf-lib";

import type { ReportSectionModel, TableColumn, TableRow } from "../report-sections/types";

// Reports Final-Master (spec section 17): the real print PDF renderer. NOT a screenshot of the web
// UI - a purpose-built, manually-laid-out A4 document composed from the SAME ReportSectionModel[] the
// Evidence Preview and XLSX renderer consume (spec section 6). Built on `pdf-lib` (no native
// bindings/headless-Chrome dependency - the same underlying primitive src/server/exports/pdf.ts uses),
// but this is its own module: exports' pdf.ts is a single-table, single-page-size generator hardwired
// to ExportColumnDef/ExportRow and cannot compose a multi-section document with a cover page, KPI
// tiles, running header/footer or page numbers - see the task's own recon item 7.
//
// CreatorOps brand tokens (spec section 17 "Visual style"): dark Ink/Navy for headings/structure,
// CreatorOps Orange for selective emphasis, a pale-orange highlight, neutral gray tables, blue only
// for actual links.
const INK_NAVY = rgb(0.09, 0.13, 0.24);
const ORANGE = rgb(0.85, 0.42, 0.08);
const PALE_ORANGE = rgb(0.99, 0.93, 0.85);
const GRAY_HEADER = rgb(0.92, 0.92, 0.93);
const GRAY_ROW_ALT = rgb(0.97, 0.97, 0.98);
const GRAY_BORDER = rgb(0.75, 0.75, 0.77);
const TEXT_DARK = rgb(0.15, 0.15, 0.17);
const TEXT_MUTED = rgb(0.4, 0.4, 0.43);
const LINK_BLUE = rgb(0.11, 0.36, 0.78);

const PAGE_WIDTH = 595.28; // A4 portrait, points.
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_HEIGHT = 28;
const HEADER_HEIGHT = 24;
const MAX_LINES_PER_CELL = 3;

export type PdfReportMeta = {
  templateTitle: string;
  reportPurpose: string;
  scopeLine: string;
  periodLine: string;
  generatedAtLine: string;
  evidenceCutoffLine: string;
  versionLabel: string; // e.g. "Version 2 - FINALIZED"
  finalizedLine: string | null; // e.g. "Finalized 2026-08-31T00:00:00.000Z by <userRef>" or null while drafting.
};

// Wraps the FULL text with no line cap first, then only truncates (with a visible "…" marker) if the
// full wrap genuinely exceeds maxLines - never appends "…" to a line that happens to land exactly on
// the cap but would not actually have continued (a real bug an earlier "break out of the word loop as
// soon as we hit maxLines" version had: it could not tell "ran out of words" apart from "ran out of
// room", so it silently truncated text that already fit - caught during this stage's own PDF visual
// inspection, spec section 29).
function wrapAllLines(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  if (text.length === 0) return [""];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || current.length === 0) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function wrapText(font: PDFFont, text: string, size: number, maxWidth: number, maxLines = MAX_LINES_PER_CELL): string[] {
  const all = wrapAllLines(font, text, size, maxWidth);
  if (all.length <= maxLines) return all;
  const bounded = all.slice(0, maxLines);
  let last = bounded[maxLines - 1] ?? "";
  while (font.widthOfTextAtSize(`${last}…`, size) > maxWidth && last.length > 0) last = last.slice(0, -1);
  bounded[maxLines - 1] = `${last}…`;
  return bounded;
}

const URL_PATTERN = /^https?:\/\/\S+$/i;

// Spec sections 17/20: "blue only for actual links" / "PDF should contain clickable links". A cell
// whose raw evidence value is a genuine http(s) URL is rendered in LINK_BLUE and given a real clickable
// annotation over its bounding box - pdf-lib has no high-level `drawLink` helper, so this builds the
// PDF /Link annotation dictionary directly (a documented, standard low-level pdf-lib recipe).
function addLinkAnnotation(page: PDFPage, url: string, rect: { x: number; y: number; width: number; height: number }): void {
  const doc = page.doc;
  const annotationRef = doc.context.register(
    doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
      Border: [0, 0, 0],
      C: [0.11, 0.36, 0.78],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    }),
  );
  const existing = page.node.lookup(PDFName.of("Annots"));
  const annots = existing instanceof PDFArray ? existing : doc.context.obj([]);
  annots.push(annotationRef as PDFRef);
  page.node.set(PDFName.of("Annots"), annots);
}

function isUrl(value: string | number | boolean | null): value is string {
  return typeof value === "string" && URL_PATTERN.test(value);
}

function cellText(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return "Not available";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("en-IN") : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return value;
}

type DocState = { doc: PDFDocument; font: PDFFont; bold: PDFFont; page: PDFPage; y: number; pageNumber: number; meta: PdfReportMeta };

function newPage(state: DocState): void {
  state.page = state.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  state.pageNumber += 1;
  state.y = PAGE_HEIGHT - MARGIN - HEADER_HEIGHT;
  drawRunningHeader(state);
}

function drawRunningHeader(state: DocState): void {
  const { page, font, meta } = state;
  page.drawText(meta.templateTitle, { x: MARGIN, y: PAGE_HEIGHT - MARGIN + 6, size: 9, font, color: TEXT_MUTED });
  page.drawLine({ start: { x: MARGIN, y: PAGE_HEIGHT - MARGIN }, end: { x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - MARGIN }, thickness: 0.75, color: ORANGE });
}

function drawFooter(state: DocState): void {
  const { page, font, meta, pageNumber } = state;
  page.drawLine({ start: { x: MARGIN, y: MARGIN }, end: { x: PAGE_WIDTH - MARGIN, y: MARGIN }, thickness: 0.5, color: GRAY_BORDER });
  page.drawText(meta.versionLabel, { x: MARGIN, y: MARGIN - 14, size: 8, font, color: TEXT_MUTED });
  const pageLabel = `Page ${pageNumber}`;
  const pageLabelWidth = font.widthOfTextAtSize(pageLabel, 8);
  page.drawText(pageLabel, { x: PAGE_WIDTH - MARGIN - pageLabelWidth, y: MARGIN - 14, size: 8, font, color: TEXT_MUTED });
}

function ensureSpace(state: DocState, needed: number): void {
  if (state.y - needed < MARGIN + FOOTER_HEIGHT) newPage(state);
}

function drawSectionTitle(state: DocState, title: string, unavailableReason?: string): void {
  ensureSpace(state, 30);
  state.page.drawText(title, { x: MARGIN, y: state.y, size: 13, font: state.bold, color: INK_NAVY });
  state.y -= 6;
  state.page.drawLine({ start: { x: MARGIN, y: state.y }, end: { x: MARGIN + 60, y: state.y }, thickness: 2, color: ORANGE });
  state.y -= 16;
  if (unavailableReason) {
    const lines = wrapText(state.font, unavailableReason, 9, CONTENT_WIDTH, 6);
    for (const line of lines) {
      ensureSpace(state, 12);
      state.page.drawText(line, { x: MARGIN, y: state.y, size: 9, font: state.font, color: TEXT_MUTED });
      state.y -= 12;
    }
    state.y -= 6;
  }
}

function drawKpiGrid(state: DocState, items: { label: string; value: string; unavailable?: boolean }[]): void {
  const cols = 3;
  const cardWidth = (CONTENT_WIDTH - (cols - 1) * 10) / cols;
  const cardHeight = 40;
  let col = 0;
  for (const item of items) {
    if (col === 0) ensureSpace(state, cardHeight + 8);
    const x = MARGIN + col * (cardWidth + 10);
    state.page.drawRectangle({ x, y: state.y - cardHeight, width: cardWidth, height: cardHeight, color: PALE_ORANGE, borderColor: GRAY_BORDER, borderWidth: 0.5 });
    const labelLines = wrapText(state.font, item.label, 7.5, cardWidth - 8, 2);
    labelLines.forEach((line, i) => state.page.drawText(line, { x: x + 6, y: state.y - 12 - i * 9, size: 7.5, font: state.font, color: TEXT_MUTED }));
    const valueText = item.unavailable ? "Not available" : item.value;
    state.page.drawText(valueText, { x: x + 6, y: state.y - cardHeight + 10, size: 12, font: state.bold, color: item.unavailable ? TEXT_MUTED : INK_NAVY, maxWidth: cardWidth - 12 });
    col += 1;
    if (col >= cols) {
      col = 0;
      state.y -= cardHeight + 8;
    }
  }
  if (col !== 0) state.y -= cardHeight + 8;
  state.y -= 4;
}

function drawTable(state: DocState, columns: TableColumn[], rows: TableRow[], totalsRow: TableRow | undefined, emptyMessage: string | undefined, note: string | undefined): void {
  if (note) {
    const lines = wrapText(state.font, note, 8.5, CONTENT_WIDTH, 4);
    for (const line of lines) {
      ensureSpace(state, 11);
      state.page.drawText(line, { x: MARGIN, y: state.y, size: 8.5, font: state.font, color: TEXT_MUTED });
      state.y -= 11;
    }
    state.y -= 4;
  }
  if (rows.length === 0) {
    ensureSpace(state, 14);
    state.page.drawText(emptyMessage ?? "No rows in this run.", { x: MARGIN, y: state.y, size: 9, font: state.font, color: TEXT_MUTED });
    state.y -= 18;
    return;
  }
  const colCount = Math.max(columns.length, 1);
  const colWidth = CONTENT_WIDTH / colCount;
  const MIN_HEADER_ROW_HEIGHT = 16;
  const HEADER_LINE_HEIGHT = 10;
  const LINE_HEIGHT = 10.5;

  // A narrow multi-column table (e.g. the 11-column Instagram/YouTube Partner Performance tables)
  // routinely needs a column label wider than its own column - "Published Content Count",
  // "Has Compliance Evidence" - so the header, like every data cell already does, must wrap onto
  // multiple lines and the header row's own height must grow to fit that wrap. The PREVIOUS version
  // of this function drew each header label as a single line inside a FIXED 16pt-tall box: pdf-lib's
  // own `maxWidth` option on drawText silently wraps long text onto additional lines with no error,
  // but this function never accounted for that extra height, so a wrapped 2-3-line header visually
  // overlapped the first data row beneath it - a real overlap bug, caught during this stage's own
  // independent PDF visual-inspection pass (spec section 29's own explicit "no ... overlap" check).
  function drawHeaderRow(): void {
    const wrappedHeaders = columns.map((col) => wrapText(state.bold, col.label, 8.5, colWidth - 8, 2));
    const headerLineCount = Math.max(...wrappedHeaders.map((l) => l.length), 1);
    const headerRowHeight = Math.max(MIN_HEADER_ROW_HEIGHT, headerLineCount * HEADER_LINE_HEIGHT + 6);
    ensureSpace(state, headerRowHeight + 4);
    state.page.drawRectangle({ x: MARGIN, y: state.y - headerRowHeight + 4, width: CONTENT_WIDTH, height: headerRowHeight, color: GRAY_HEADER });
    columns.forEach((col, i) => {
      wrappedHeaders[i]!.forEach((line, li) => {
        state.page.drawText(line, { x: MARGIN + i * colWidth + 4, y: state.y - 8 - li * HEADER_LINE_HEIGHT, size: 8.5, font: state.bold, color: INK_NAVY, maxWidth: colWidth - 8 });
      });
    });
    state.y -= headerRowHeight;
  }

  drawHeaderRow();
  rows.forEach((row, rowIndex) => {
    const wrapped = columns.map((col) => wrapText(state.font, cellText(row[col.id] ?? null), 8, colWidth - 8));
    const lineCount = Math.max(...wrapped.map((l) => l.length), 1);
    const rowHeight = lineCount * LINE_HEIGHT + 4;
    if (state.y - rowHeight < MARGIN + FOOTER_HEIGHT) {
      newPage(state);
      drawHeaderRow();
    }
    if (rowIndex % 2 === 1) state.page.drawRectangle({ x: MARGIN, y: state.y - rowHeight + 2, width: CONTENT_WIDTH, height: rowHeight, color: GRAY_ROW_ALT });
    columns.forEach((col, i) => {
      const lines = wrapped[i]!;
      const x = MARGIN + i * colWidth + 4;
      const textWidth = colWidth - 8;
      const rawValue = row[col.id] ?? null;
      const link = isUrl(rawValue) ? rawValue : null;
      lines.forEach((line, li) => {
        const isNumeric = col.numeric === true;
        const lineWidth = state.font.widthOfTextAtSize(line, 8);
        const drawX = isNumeric ? x + Math.max(0, textWidth - lineWidth) : x;
        const lineY = state.y - 9 - li * LINE_HEIGHT;
        state.page.drawText(line, { x: drawX, y: lineY, size: 8, font: state.font, color: link ? LINK_BLUE : TEXT_DARK, maxWidth: textWidth });
        if (link) addLinkAnnotation(state.page, link, { x: drawX, y: lineY - 2, width: lineWidth, height: LINE_HEIGHT });
      });
    });
    state.y -= rowHeight;
  });

  if (totalsRow) {
    const wrapped = columns.map((col) => cellText(totalsRow[col.id] ?? null));
    if (state.y - 16 < MARGIN + FOOTER_HEIGHT) {
      newPage(state);
      drawHeaderRow();
    }
    state.page.drawLine({ start: { x: MARGIN, y: state.y + 2 }, end: { x: PAGE_WIDTH - MARGIN, y: state.y + 2 }, thickness: 0.75, color: GRAY_BORDER });
    columns.forEach((col, i) => {
      state.page.drawText(wrapped[i]!, { x: MARGIN + i * colWidth + 4, y: state.y - 9, size: 8.5, font: state.bold, color: INK_NAVY, maxWidth: colWidth - 8 });
    });
    state.y -= 16;
  }
  state.y -= 10;
}

function drawNarrative(state: DocState, body: string, reviewStatus?: string): void {
  if (reviewStatus) {
    ensureSpace(state, 12);
    state.page.drawText(`[${reviewStatus}]`, { x: MARGIN, y: state.y, size: 8, font: state.font, color: TEXT_MUTED });
    state.y -= 12;
  }
  const paragraphs = body.length > 0 ? body.split(/\n{2,}/) : ["(No narrative has been written for this section yet.)"];
  for (const paragraph of paragraphs) {
    const lines = wrapText(state.font, paragraph, 10, CONTENT_WIDTH, 200);
    for (const line of lines) {
      ensureSpace(state, 14);
      state.page.drawText(line, { x: MARGIN, y: state.y, size: 10, font: state.font, color: TEXT_DARK });
      state.y -= 14;
    }
    state.y -= 6;
  }
}

function drawDataQuality(state: DocState, items: { label: string; value: string; unavailable?: boolean }[], warnings: string[]): void {
  for (const item of items) {
    ensureSpace(state, 13);
    state.page.drawText(`${item.label}: `, { x: MARGIN, y: state.y, size: 9, font: state.bold, color: INK_NAVY });
    const labelWidth = state.bold.widthOfTextAtSize(`${item.label}: `, 9);
    state.page.drawText(item.value, { x: MARGIN + labelWidth, y: state.y, size: 9, font: state.font, color: item.unavailable ? TEXT_MUTED : TEXT_DARK });
    state.y -= 13;
  }
  if (warnings.length > 0) {
    state.y -= 6;
    ensureSpace(state, 12);
    state.page.drawText("Limitations & disclosures:", { x: MARGIN, y: state.y, size: 9, font: state.bold, color: INK_NAVY });
    state.y -= 13;
    for (const warning of warnings) {
      const lines = wrapText(state.font, `• ${warning}`, 8.5, CONTENT_WIDTH, 4);
      for (const line of lines) {
        ensureSpace(state, 11);
        state.page.drawText(line, { x: MARGIN, y: state.y, size: 8.5, font: state.font, color: TEXT_MUTED });
        state.y -= 11;
      }
    }
  }
}

function drawCover(state: DocState, section: Extract<ReportSectionModel, { kind: "cover" }>): void {
  state.page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 180, width: PAGE_WIDTH, height: 180, color: INK_NAVY });
  state.page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 184, width: PAGE_WIDTH, height: 4, color: ORANGE });
  state.page.drawText("CreatorOps", { x: MARGIN, y: PAGE_HEIGHT - 40, size: 11, font: state.bold, color: ORANGE });
  const titleLines = wrapText(state.bold, section.title, 24, CONTENT_WIDTH, 2);
  titleLines.forEach((line, i) => state.page.drawText(line, { x: MARGIN, y: PAGE_HEIGHT - 80 - i * 28, size: 24, font: state.bold, color: rgb(1, 1, 1) }));
  const subtitleLines = wrapText(state.font, section.subtitle, 10.5, CONTENT_WIDTH, 2);
  subtitleLines.forEach((line, i) => state.page.drawText(line, { x: MARGIN, y: PAGE_HEIGHT - 140 - i * 14, size: 10.5, font: state.font, color: rgb(0.85, 0.85, 0.9) }));

  state.y = PAGE_HEIGHT - 220;
  const metaLines = [section.scopeLine, section.periodLine, section.generatedAtLine, section.evidenceCutoffLine, state.meta.versionLabel, state.meta.finalizedLine ?? "Status: DRAFT (not yet finalized)"];
  for (const line of metaLines) {
    const wrapped = wrapText(state.font, line, 10, CONTENT_WIDTH, 3);
    for (const l of wrapped) {
      state.page.drawText(l, { x: MARGIN, y: state.y, size: 10, font: state.font, color: TEXT_DARK });
      state.y -= 15;
    }
  }
  state.y -= 20;
}

export async function generateReportPdf(sections: ReportSectionModel[], meta: PdfReportMeta): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(meta.templateTitle);
  doc.setSubject(meta.reportPurpose);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const state: DocState = { doc, font, bold, page, y: PAGE_HEIGHT - MARGIN, pageNumber: 1, meta };

  for (const section of sections) {
    if (section.kind === "cover") {
      drawCover(state, section);
      continue;
    }
    drawSectionTitle(state, section.title, section.unavailableReason);
    if (section.kind === "kpi_summary") drawKpiGrid(state, section.items);
    else if (section.kind === "kpi_cards") drawKpiGrid(state, section.cards);
    else if (section.kind === "table") drawTable(state, section.columns, section.rows, section.totalsRow, section.emptyMessage, section.note);
    else if (section.kind === "narrative") drawNarrative(state, section.body, section.reviewStatus);
    else if (section.kind === "data_quality") drawDataQuality(state, section.items, section.warnings);
    state.y -= 8;
  }

  // Footer/page-number pass over every page created (drawFooter needs the final pageNumber sequence,
  // so it is applied in one pass at the end rather than interleaved with newPage()).
  const pages = doc.getPages();
  pages.forEach((p, index) => {
    state.page = p;
    state.pageNumber = index + 1;
    drawFooter(state);
  });

  return doc.save();
}
