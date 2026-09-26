import * as XLSX from "xlsx";

import { neutralizeFormulaInjection } from "./csv";
import type { ExportColumnDef, ExportRow, ExportRowValue } from "./types";

// XLSX generation via the project's existing `xlsx` dependency. Deterministic single worksheet,
// deterministic column order (exactly the order the caller passes). Cells are typed explicitly
// ("s" for text, "n" for number, "b" for boolean) rather than left to `xlsx`'s own type inference,
// so a value is never silently reinterpreted.
//
// Formula-injection mitigation (same real vulnerability class as csv.ts - see that file's own
// comment): even though a properly-typed string cell ("s") is not itself a formula cell ("f") and
// Excel will not evaluate it as one, the same leading-character neutralization is applied here too,
// per the spec's explicit "same mitigation as CSV" requirement - defense in depth against any
// downstream tool (a re-export to CSV, a copy-paste, a naive importer) that infers cell type from
// text content rather than trusting the stored cell type.
function cellValue(value: ExportRowValue): { t: XLSX.ExcelDataType; v: string | number | boolean } {
  if (value === null || value === undefined) return { t: "s", v: "" };
  if (typeof value === "boolean") return { t: "b", v: value };
  if (typeof value === "number") return { t: "n", v: Number.isFinite(value) ? value : 0 };
  return { t: "s", v: neutralizeFormulaInjection(value) };
}

export function generateXlsx(columns: ExportColumnDef[], rows: ExportRow[]): Uint8Array {
  const sheet: XLSX.WorkSheet = {};
  const range = { s: { r: 0, c: 0 }, e: { r: rows.length, c: Math.max(columns.length - 1, 0) } };

  columns.forEach((col, colIndex) => {
    const headerAddr = XLSX.utils.encode_cell({ r: 0, c: colIndex });
    sheet[headerAddr] = { t: "s", v: col.label };
  });

  rows.forEach((row, rowIndex) => {
    columns.forEach((col, colIndex) => {
      const addr = XLSX.utils.encode_cell({ r: rowIndex + 1, c: colIndex });
      const { t, v } = cellValue(row[col.id] ?? null);
      sheet[addr] = { t, v };
    });
  });

  sheet["!ref"] = XLSX.utils.encode_range(range);

  const workbook: XLSX.WorkBook = { SheetNames: ["Export"], Sheets: { Export: sheet } };
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new Uint8Array(buffer);
}

// Parses a generated workbook back - used by tests to verify real round-trip correctness (per the
// spec's explicit "parse your own generated file back... don't just assert no exception was thrown").
export function parseXlsxForVerification(bytes: Uint8Array): { headers: string[]; rows: (string | number | boolean | null)[][] } {
  const workbook = XLSX.read(Buffer.from(bytes), { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const table = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, { header: 1, defval: null, raw: true });
  const [headers, ...dataRows] = table as unknown as [string[], ...(string | number | boolean | null)[][]];
  return { headers: headers ?? [], rows: dataRows ?? [] };
}
