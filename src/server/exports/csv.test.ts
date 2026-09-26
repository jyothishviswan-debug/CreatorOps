import { describe, expect, it } from "vitest";

import { generateCsv, neutralizeFormulaInjection } from "./csv";
import type { ExportColumnDef, ExportRow } from "./types";

const columns: ExportColumnDef[] = [
  { id: "a", label: "Col A" },
  { id: "b", label: "Col B" },
];

describe("neutralizeFormulaInjection", () => {
  it("prefixes a leading =, +, -, @, tab or CR with a single quote", () => {
    expect(neutralizeFormulaInjection("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(neutralizeFormulaInjection("+1+1")).toBe("'+1+1");
    expect(neutralizeFormulaInjection("-cmd|' /C calc'!A1")).toBe("'-cmd|' /C calc'!A1");
    expect(neutralizeFormulaInjection("@SUM(1,2)")).toBe("'@SUM(1,2)");
    expect(neutralizeFormulaInjection("\tevil")).toBe("'\tevil");
    expect(neutralizeFormulaInjection("\revil")).toBe("'\revil");
  });

  it("leaves an ordinary string untouched", () => {
    expect(neutralizeFormulaInjection("Kerala")).toBe("Kerala");
    expect(neutralizeFormulaInjection("")).toBe("");
  });
});

describe("generateCsv", () => {
  it("produces a deterministic header row in the exact column order given", () => {
    const csv = generateCsv(columns, []);
    expect(csv).toBe("Col A,Col B\r\n");
  });

  it("quotes fields containing commas, quotes, or newlines per RFC 4180", () => {
    const rows: ExportRow[] = [{ a: 'has, comma and "quote"', b: "line1\nline2" }];
    const csv = generateCsv(columns, rows);
    expect(csv).toContain('"has, comma and ""quote"""');
    expect(csv).toContain('"line1\nline2"');
  });

  it("neutralizes formula-injection payloads in string cells", () => {
    const rows: ExportRow[] = [{ a: "=cmd|'/c calc'!A1", b: "ok" }];
    const csv = generateCsv(columns, rows);
    expect(csv).toContain("'=cmd|'/c calc'!A1");
  });

  it("renders null as an empty cell, never as a fabricated 0 or the word null", () => {
    const rows: ExportRow[] = [{ a: null, b: 0 }];
    const csv = generateCsv(columns, rows);
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine).toBe(",0");
  });

  it("renders booleans as true/false text", () => {
    const rows: ExportRow[] = [{ a: true, b: false }];
    const csv = generateCsv(columns, rows);
    expect(csv.split("\r\n")[1]).toBe("true,false");
  });

  it("round-trips real UTF-8 text (non-ASCII display names)", () => {
    const rows: ExportRow[] = [{ a: "Café Créateur — 日本語", b: "ok" }];
    const csv = generateCsv(columns, rows);
    const decoded = Buffer.from(csv, "utf8").toString("utf8");
    expect(decoded).toContain("Café Créateur — 日本語");
  });
});
