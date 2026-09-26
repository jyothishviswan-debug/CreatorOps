import { PDFDocument, PDFFont, StandardFonts, rgb } from "pdf-lib";

import type { ExportColumnDef, ExportFormat, ExportRow, ExportRowValue } from "./types";

// PDF generation via pdf-lib (no native bindings, plain Node runtime - safe inside a Next.js API
// route, unlike a headless-Chrome-based generator). Renders a simple, bounded table: a title/context
// header (target, format, applied filters, generated-at, row-count/truncation disclosure) followed by
// one row per record, word-wrapped to fit its column so no cell is silently clipped - a cell whose
// content still does not fit within a bounded number of lines is truncated with a visible "…" marker
// (an explicit, visible truncation, never a silent clip).
const PAGE_WIDTH = 841.89; // A4 landscape, in points - wide enough for a multi-column record table.
const PAGE_HEIGHT = 595.28;
const MARGIN = 36;
const HEADER_FONT_SIZE = 8.5;
const BODY_FONT_SIZE = 8;
const LINE_HEIGHT = 10.5;
const MAX_LINES_PER_CELL = 3;
// PDF is a human-readable document, not a bulk data file - bounded independently (and more tightly)
// than the target's own maxRows, which governs CSV/XLSX. Disclosed explicitly in the header when hit.
export const PDF_MAX_ROWS = 150;

function cellText(value: ExportRowValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
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
    if (lines.length >= MAX_LINES_PER_CELL) break;
  }
  if (lines.length < MAX_LINES_PER_CELL && current.length > 0) lines.push(current);
  if (lines.length >= MAX_LINES_PER_CELL) {
    // Explicit, visible truncation marker - never a silent clip.
    let last = lines[MAX_LINES_PER_CELL - 1] ?? "";
    while (font.widthOfTextAtSize(`${last}…`, size) > maxWidth && last.length > 0) last = last.slice(0, -1);
    lines[MAX_LINES_PER_CELL - 1] = `${last}…`;
  }
  return lines.length > 0 ? lines.slice(0, MAX_LINES_PER_CELL) : [""];
}

export type PdfContext = {
  targetTitle: string;
  format: ExportFormat;
  appliedFilters: Record<string, string>;
  generatedAt: string;
  rowCount: number;
  maxRows: number;
  truncated: boolean;
  pdfRowLimitApplied: boolean;
};

export async function generatePdf(columns: ExportColumnDef[], rows: ExportRow[], context: PdfContext): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  const usableWidth = PAGE_WIDTH - MARGIN * 2;
  const colCount = Math.max(columns.length, 1);
  const colWidth = usableWidth / colCount;

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  function drawHeaderBlock(): void {
    page.drawText(`Export: ${context.targetTitle}`, { x: MARGIN, y, size: 14, font: boldFont, color: rgb(0.1, 0.1, 0.1) });
    y -= 18;
    const filterEntries = Object.entries(context.appliedFilters);
    const filterText = filterEntries.length > 0 ? filterEntries.map(([k, v]) => `${k}=${v}`).join(", ") : "none";
    const metaLines = [`Format: ${context.format.toUpperCase()}`, `Generated at: ${context.generatedAt}`, `Filters: ${filterText}`, `Rows: ${context.rowCount} (max ${context.maxRows})${context.truncated ? " - TRUNCATED, more rows exist than shown" : ""}${context.pdfRowLimitApplied ? ` - PDF view limited to ${PDF_MAX_ROWS} rows; use CSV/XLSX for the full set` : ""}`];
    for (const line of metaLines) {
      page.drawText(line, { x: MARGIN, y, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
      y -= 12;
    }
    y -= 6;
    drawTableHeader();
  }

  function drawTableHeader(): void {
    columns.forEach((col, i) => {
      page.drawText(col.label, { x: MARGIN + i * colWidth, y, size: HEADER_FONT_SIZE, font: boldFont, color: rgb(0, 0, 0), maxWidth: colWidth - 4 });
    });
    y -= LINE_HEIGHT + 4;
    page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: PAGE_WIDTH - MARGIN, y: y + 4 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  }

  function newPage(): void {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
    drawTableHeader();
  }

  drawHeaderBlock();

  for (const row of rows) {
    const wrapped = columns.map((col) => wrapText(font, cellText(row[col.id] ?? null), BODY_FONT_SIZE, colWidth - 4));
    const rowLines = Math.max(...wrapped.map((lines) => lines.length), 1);
    const rowHeight = rowLines * LINE_HEIGHT;

    if (y - rowHeight < MARGIN) newPage();

    columns.forEach((col, i) => {
      const lines = wrapped[i];
      lines.forEach((line, lineIndex) => {
        page.drawText(line, { x: MARGIN + i * colWidth, y: y - lineIndex * LINE_HEIGHT, size: BODY_FONT_SIZE, font, color: rgb(0.15, 0.15, 0.15), maxWidth: colWidth - 4 });
      });
    });
    y -= rowHeight + 3;
  }

  if (rows.length === 0) {
    page.drawText("No rows matched the applied filters.", { x: MARGIN, y, size: BODY_FONT_SIZE, font, color: rgb(0.4, 0.4, 0.4) });
  }

  const bytes = await doc.save();
  return bytes;
}
