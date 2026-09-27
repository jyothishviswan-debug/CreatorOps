import { describe, expect, it } from "vitest";

import { buildTaxonomyBreakdown } from "./taxonomy";

describe("taxonomy overlap", () => {
  it("discloses overlap when an item carries more than one tag - sum exceeds distinct item count", () => {
    const result = buildTaxonomyBreakdown([
      { itemId: "1", tags: ["topic-a", "topic-b"], metricValue: 10 },
      { itemId: "2", tags: ["topic-a"], metricValue: 5 },
    ]);
    expect(result.totalDistinctItems).toBe(2);
    expect(result.sumAcrossTags).toBe(3);
    expect(result.overlapPresent).toBe(true);
    expect(result.overlapNote).toMatch(/not additive/i);
  });

  it("reports no overlap when every item carries exactly one tag", () => {
    const result = buildTaxonomyBreakdown([
      { itemId: "1", tags: ["topic-a"], metricValue: 1 },
      { itemId: "2", tags: ["topic-b"], metricValue: 1 },
    ]);
    expect(result.overlapPresent).toBe(false);
    expect(result.sumAcrossTags).toBe(result.totalDistinctItems);
  });

  it("per-tag metricSum stays null when no item under that tag has a known metric value (missing != zero)", () => {
    const result = buildTaxonomyBreakdown([{ itemId: "1", tags: ["topic-a"], metricValue: null }]);
    const row = result.rows.find((r) => r.tag === "topic-a");
    expect(row?.metricSum).toBeNull();
    expect(row?.itemCount).toBe(1);
  });
});
