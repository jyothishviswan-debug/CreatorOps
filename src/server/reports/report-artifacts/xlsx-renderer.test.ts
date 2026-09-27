import { describe, expect, it } from "vitest";

import type { ReportSectionModel } from "../report-sections/types";
import { generateReportXlsx, parseReportXlsxForVerification } from "./xlsx-renderer";

function sections(): ReportSectionModel[] {
  return [
    { kind: "cover", sectionType: "cover", mode: "EVIDENCE", title: "T", subtitle: "s", scopeLine: "s", periodLine: "p", generatedAtLine: "g", evidenceCutoffLine: "c" },
    { kind: "kpi_summary", sectionType: "kpi_summary", mode: "EVIDENCE", title: "KPIs", items: [{ label: "Partners", value: "12" }] },
    { kind: "table", sectionType: "partner_performance_table", mode: "EVIDENCE", title: "Partner Performance", columns: [{ id: "name", label: "Partner" }, { id: "views", label: "Views", numeric: true }], rows: [{ name: "A", views: 100 }, { name: "=SUM(A1:A2)", views: 200 }] },
    { kind: "data_quality", sectionType: "data_quality", mode: "EVIDENCE", title: "Data Coverage & Quality", items: [{ label: "Rows", value: "2" }], warnings: ["A limitation."] },
  ];
}

describe("XLSX renderer", () => {
  it("round-trips a real workbook with the expected sheets", () => {
    const bytes = generateReportXlsx(sections(), { templateTitle: "Test", versionLabel: "Version 1", generatedAtLine: "g" });
    const parsed = parseReportXlsxForVerification(bytes);
    expect(parsed.sheetNames).toContain("Summary");
    expect(parsed.sheetNames).toContain("Partner Performance");
    expect(parsed.sheetNames).toContain("Data Quality");
  });

  it("includes KPI values on the Summary sheet", () => {
    const bytes = generateReportXlsx(sections(), { templateTitle: "Test", versionLabel: "Version 1", generatedAtLine: "g" });
    const parsed = parseReportXlsxForVerification(bytes);
    const summary = parsed.sheets.Summary!;
    const flat = summary.flat();
    expect(flat).toContain("Partners");
    expect(flat).toContain("12");
  });

  it("neutralizes a formula-injection-triggering string cell value", () => {
    const bytes = generateReportXlsx(sections(), { templateTitle: "Test", versionLabel: "Version 1", generatedAtLine: "g" });
    const parsed = parseReportXlsxForVerification(bytes);
    const table = parsed.sheets["Partner Performance"]!;
    const hostileRow = table.find((row) => typeof row[0] === "string" && (row[0] as string).includes("SUM"));
    expect(hostileRow).toBeDefined();
    expect((hostileRow![0] as string).startsWith("'")).toBe(true);
  });

  it("de-duplicates sheet names that collide after 28-char truncation", () => {
    const longA: ReportSectionModel = { kind: "table", sectionType: "ranked_table", mode: "EVIDENCE", title: "A Very Long Section Title That Repeats", columns: [{ id: "x", label: "X" }], rows: [{ x: 1 }] };
    const longB: ReportSectionModel = { kind: "table", sectionType: "ranked_table", mode: "EVIDENCE", title: "A Very Long Section Title That Also Repeats", columns: [{ id: "x", label: "X" }], rows: [{ x: 1 }] };
    const bytes = generateReportXlsx([longA, longB], { templateTitle: "Test", versionLabel: "Version 1", generatedAtLine: "g" });
    const parsed = parseReportXlsxForVerification(bytes);
    expect(new Set(parsed.sheetNames).size).toBe(parsed.sheetNames.length);
  });
});
