import { describe, expect, it } from "vitest";

import { buildDataQualitySection } from "./data-quality";

const baseInput = {
  generatedAt: "2026-08-31T00:00:00.000Z",
  evidenceCutoff: "2026-08-30T00:00:00.000Z",
  truncated: false,
  rowCount: 10,
  maxRows: 200,
  limitations: ["Some limitation."],
  provenance: [{ sourceModule: "partners", sourceFunction: "listPartners", recordCount: 10 }],
};

describe("Data Coverage & Quality section", () => {
  it("always includes generatedAt/evidenceCutoff/rowCount/truncated", () => {
    const section = buildDataQualitySection(baseInput);
    const labels = section.items.map((i) => i.label);
    expect(labels).toContain("Report generated at");
    expect(labels).toContain("Evidence cutoff (source freshness)");
    expect(labels.some((l) => l.includes("Rows returned"))).toBe(true);
  });

  it("marks unavailable metrics explicitly, never as zero or estimated", () => {
    const section = buildDataQualitySection({ ...baseInput, unavailableMetrics: ["reach"] });
    const item = section.items.find((i) => i.label.includes("reach"));
    expect(item?.unavailable).toBe(true);
    expect(item?.value).toMatch(/not available/i);
  });

  it("surfaces every limitation as a warning", () => {
    const section = buildDataQualitySection(baseInput);
    expect(section.warnings).toEqual(baseInput.limitations);
  });

  it("includes every provenance source", () => {
    const section = buildDataQualitySection(baseInput);
    expect(section.items.some((i) => i.label.includes("partners.listPartners"))).toBe(true);
  });
});
