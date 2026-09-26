import { describe, expect, it } from "vitest";

import type { ExportColumnDef, ExportRow } from "./types";
import { generateXlsx, parseXlsxForVerification } from "./xlsx";

const columns: ExportColumnDef[] = [
  { id: "ref", label: "Ref" },
  { id: "name", label: "Name" },
  { id: "count", label: "Count" },
  { id: "active", label: "Active" },
];

describe("generateXlsx + parseXlsxForVerification (real round-trip, not just no-exception)", () => {
  it("generates a workbook that a real parser reads back with the exact headers and cell values", () => {
    const rows: ExportRow[] = [
      { ref: "p_001", name: "Creator House", count: 42, active: true },
      { ref: "p_002", name: "Studio Two", count: 0, active: false },
      { ref: "p_003", name: null, count: null, active: null },
    ];
    const bytes = generateXlsx(columns, rows);
    expect(bytes.byteLength).toBeGreaterThan(0);

    const parsed = parseXlsxForVerification(bytes);
    expect(parsed.headers).toEqual(["Ref", "Name", "Count", "Active"]);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0]).toEqual(["p_001", "Creator House", 42, true]);
    expect(parsed.rows[1]).toEqual(["p_002", "Studio Two", 0, false]);
    // Null renders as an empty string cell, never a fabricated 0/false.
    expect(parsed.rows[2][0]).toBe("p_003");
    expect(parsed.rows[2][1]).toBe("");
  });

  it("neutralizes a formula-injection payload so the stored cell text is inert, and types it as a string cell (never a formula cell)", () => {
    const rows: ExportRow[] = [{ ref: "p_004", name: "=cmd|'/c calc'!A1", count: 1, active: true }];
    const bytes = generateXlsx(columns, rows);
    const parsed = parseXlsxForVerification(bytes);
    expect(String(parsed.rows[0][1])).toMatch(/^'=/);
  });

  it("handles an empty row set (headers only)", () => {
    const bytes = generateXlsx(columns, []);
    const parsed = parseXlsxForVerification(bytes);
    expect(parsed.headers).toEqual(["Ref", "Name", "Count", "Active"]);
    expect(parsed.rows).toHaveLength(0);
  });
});
