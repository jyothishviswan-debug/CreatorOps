import { describe, expect, it } from "vitest";

import type { ReportSectionModel } from "../report-sections/types";
import { generateReportCsv, pickCsvSection } from "./csv-renderer";

function sections(): ReportSectionModel[] {
  return [
    { kind: "cover", sectionType: "cover", mode: "EVIDENCE", title: "T", subtitle: "s", scopeLine: "s", periodLine: "p", generatedAtLine: "g", evidenceCutoffLine: "c" },
    { kind: "table", sectionType: "top_n_content", mode: "EVIDENCE", title: "Unavailable", unavailableReason: "not available", columns: [], rows: [] },
    { kind: "table", sectionType: "partner_performance_table", mode: "EVIDENCE", title: "Instagram Partner Performance", columns: [{ id: "name", label: "Partner" }], rows: [{ name: "A" }] },
  ];
}

describe("CSV renderer", () => {
  it("picks the preferred declared table for a known template", () => {
    const section = pickCsvSection("monthly_partner_performance", sections());
    expect(section?.title).toBe("Instagram Partner Performance");
  });

  it("never picks an unavailable/empty table", () => {
    const section = pickCsvSection("unknown_template", sections());
    expect(section?.title).toBe("Instagram Partner Performance");
  });

  it("returns null when no table has any exportable rows", () => {
    const onlyUnavailable = sections().slice(0, 2);
    expect(pickCsvSection("monthly_partner_performance", onlyUnavailable)).toBeNull();
  });

  it("generates real, parseable CSV text with a header row matching the chosen section's columns", () => {
    const result = generateReportCsv("monthly_partner_performance", sections());
    expect(result).not.toBeNull();
    expect(result!.csv.split("\r\n")[0]).toBe("Partner");
    expect(result!.sectionTitle).toBe("Instagram Partner Performance");
  });
});
