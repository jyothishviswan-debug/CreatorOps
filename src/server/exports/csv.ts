import type { ExportColumnDef, ExportRow, ExportRowValue } from "./types";

// CSV generation. Deterministic column order (exactly the order the caller passes - see
// export-service.ts, which always passes catalog-declared column order, never client-supplied
// order), RFC 4180-style quoting, UTF-8 text.
//
// Formula-injection mitigation (a well-known real vulnerability class: a cell opened in Excel/Sheets
// that begins with =, +, -, @, a tab, or a carriage return can be interpreted as a formula and used
// to exfiltrate data or run a DDE/command payload). Every STRING cell value is checked before
// quoting; if it starts with one of those characters, a single leading apostrophe is prefixed so
// spreadsheet software renders it as inert text, never a formula. Numbers/booleans/null are never
// subject to this (they cannot begin with those characters once stringified in a way that matters -
// a negative number's leading "-" is normal numeric text, not an injected formula, so mitigation only
// ever applies to genuinely untrusted STRING source values).
const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function neutralizeFormulaInjection(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_TRIGGER_CHARS.has(value[0]) ? `'${value}` : value;
}

function cellToText(value: ExportRowValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return neutralizeFormulaInjection(value);
}

// RFC 4180: a field containing a comma, double quote, or newline is wrapped in double quotes, and
// any double quote inside it is doubled.
function quoteCsvField(text: string): string {
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function generateCsv(columns: ExportColumnDef[], rows: ExportRow[]): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => quoteCsvField(c.label)).join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => quoteCsvField(cellToText(row[c.id] ?? null))).join(","));
  }
  // CRLF line endings are the RFC 4180 default and what every mainstream spreadsheet tool expects.
  return lines.join("\r\n") + "\r\n";
}
