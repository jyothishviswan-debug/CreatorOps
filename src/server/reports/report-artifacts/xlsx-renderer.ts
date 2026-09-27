import * as XLSX from "xlsx";

import type { ReportSectionModel, TableColumn, TableRow } from "../report-sections/types";

// Reports Final-Master (spec section 18): report XLSX is version-pinned ANALYTICAL output, never an
// arbitrary Export-Center-style flat export. One worksheet per table-shaped section (bounded to
// Excel's own 31-char sheet-name limit, de-duplicated), plus a Summary sheet built from every
// kpi_summary/kpi_cards/cover section, plus a Data Quality sheet. Same explicit-cell-typing and
// formula-injection-neutralization discipline as src/server/exports/xlsx.ts (its own comment explains
// the vulnerability class this guards against) - the SAME `neutralizeFormulaInjection` function is
// reused directly (a shared, already-reviewed primitive - never re-implemented here).
import { neutralizeFormulaInjection } from "../../exports/csv";

function cellValue(value: string | number | boolean | null): { t: XLSX.ExcelDataType; v: string | number | boolean } {
  if (value === null || value === undefined) return { t: "s", v: "Not available" };
  if (typeof value === "boolean") return { t: "b", v: value };
  if (typeof value === "number") return { t: "n", v: Number.isFinite(value) ? value : 0 };
  return { t: "s", v: neutralizeFormulaInjection(value) };
}

function safeSheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 28) || "Sheet";
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base.slice(0, 25)} ${n}`;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function sheetFromTable(columns: TableColumn[], rows: TableRow[]): XLSX.WorkSheet {
  const sheet: XLSX.WorkSheet = {};
  columns.forEach((col, colIndex) => {
    sheet[XLSX.utils.encode_cell({ r: 0, c: colIndex })] = { t: "s", v: col.label };
  });
  rows.forEach((row, rowIndex) => {
    columns.forEach((col, colIndex) => {
      sheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: colIndex })] = cellValue(row[col.id] ?? null);
    });
  });
  sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 0), c: Math.max(columns.length - 1, 0) } });
  return sheet;
}

function sheetFromKeyValueRows(rows: { label: string; value: string }[]): XLSX.WorkSheet {
  return sheetFromTable(
    [
      { id: "label", label: "Item" },
      { id: "value", label: "Value" },
    ],
    rows.map((r) => ({ label: r.label, value: r.value })),
  );
}

export function generateReportXlsx(sections: ReportSectionModel[], meta: { templateTitle: string; versionLabel: string; generatedAtLine: string }): Uint8Array {
  const usedNames = new Set<string>();
  const sheetNames: string[] = [];
  const sheets: Record<string, XLSX.WorkSheet> = {};

  function addSheet(name: string, sheet: XLSX.WorkSheet): void {
    const safe = safeSheetName(name, usedNames);
    sheetNames.push(safe);
    sheets[safe] = sheet;
  }

  const summaryRows: { label: string; value: string }[] = [
    { label: "Report", value: meta.templateTitle },
    { label: "Version", value: meta.versionLabel },
    { label: "Generated", value: meta.generatedAtLine },
  ];
  for (const section of sections) {
    if (section.kind === "kpi_summary" || section.kind === "kpi_cards") {
      const items = section.kind === "kpi_summary" ? section.items : section.cards;
      for (const item of items) summaryRows.push({ label: item.label, value: item.unavailable ? "Not available" : item.value });
    }
  }
  addSheet("Summary", sheetFromKeyValueRows(summaryRows));

  for (const section of sections) {
    if (section.kind === "table" && !section.unavailableReason) {
      addSheet(section.title, sheetFromTable(section.columns, section.rows));
    } else if (section.kind === "data_quality") {
      const dqRows = section.items.map((i) => ({ label: i.label, value: i.value }));
      addSheet("Data Quality", sheetFromKeyValueRows(dqRows));
      if (section.warnings.length > 0) {
        addSheet(
          "Data Quality Notes",
          sheetFromTable(
            [{ id: "note", label: "Limitation / Disclosure" }],
            section.warnings.map((w) => ({ note: w })),
          ),
        );
      }
    }
  }

  const workbook: XLSX.WorkBook = { SheetNames: sheetNames, Sheets: sheets };
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new Uint8Array(buffer);
}

export function parseReportXlsxForVerification(bytes: Uint8Array): { sheetNames: string[]; sheets: Record<string, (string | number | boolean | null)[][]> } {
  const workbook = XLSX.read(Buffer.from(bytes), { type: "buffer" });
  const sheets: Record<string, (string | number | boolean | null)[][]> = {};
  for (const name of workbook.SheetNames) {
    sheets[name] = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(workbook.Sheets[name]!, { header: 1, defval: null, raw: true });
  }
  return { sheetNames: workbook.SheetNames, sheets };
}
