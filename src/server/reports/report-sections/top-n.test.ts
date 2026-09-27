import { describe, expect, it } from "vitest";

import { buildTopNContentTable } from "./top-n";

describe("Top-N framework", () => {
  it("returns at most N items, ranked by the stated metric", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ label: `item-${i}`, metricValue: i }));
    const section = buildTopNContentTable({ title: "Top Content", metricLabel: "Views", items, n: 5 });
    expect(section.rows).toHaveLength(5);
    expect(section.rows[0]!.label).toBe("item-19");
    expect(section.rows[4]!.label).toBe("item-15");
  });

  it("title states the ranking metric and N", () => {
    const section = buildTopNContentTable({ title: "Top Content", metricLabel: "Engagement", items: [{ label: "x", metricValue: 1 }], n: 3 });
    expect(section.title).toContain("Engagement");
    expect(section.title).toContain("Top 3");
  });

  it("excludes items with no reported metric value", () => {
    const section = buildTopNContentTable({ title: "Top Content", metricLabel: "Views", items: [{ label: "a", metricValue: null }, { label: "b", metricValue: 5 }], n: 10 });
    expect(section.rows).toHaveLength(1);
    expect(section.rows[0]!.label).toBe("b");
  });
});
