import { describe, expect, it } from "vitest";

import { buildSourceMetricLeadersTable, rankByMetric } from "./leaders";

describe("Source-Metric Leaders", () => {
  it("ranks strictly by the single supplied metric, descending", () => {
    const rows = rankByMetric([{ label: "A", value: 10 }, { label: "B", value: 30 }, { label: "C", value: 20 }], 10);
    expect(rows.map((r) => r.label)).toEqual(["B", "C", "A"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("uses dense ranking for ties (never an arbitrary tiebreak disguised as a distinct rank)", () => {
    const rows = rankByMetric([{ label: "A", value: 50 }, { label: "B", value: 50 }, { label: "C", value: 10 }], 10);
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 2]);
  });

  it("excludes null-valued candidates entirely - never ranks them last with a fabricated 0", () => {
    const rows = rankByMetric([{ label: "A", value: null }, { label: "B", value: 5 }], 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("B");
  });

  it("respects the limit", () => {
    const rows = rankByMetric([{ label: "A", value: 1 }, { label: "B", value: 2 }, { label: "C", value: 3 }], 2);
    expect(rows).toHaveLength(2);
  });

  it("the built table title states the literal metric name - never 'Overall Performance'", () => {
    const section = buildSourceMetricLeadersTable({ metricLabel: "Views", metricId: "views", platformOrContext: "instagram", candidates: [{ label: "A", value: 5 }], limit: 10 });
    expect(section.title).toContain("Views");
    expect(section.title.toLowerCase()).not.toContain("overall performance");
    expect(section.sectionType).toBe("source_metric_leaders");
  });
});
