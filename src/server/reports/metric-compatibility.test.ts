import { describe, expect, it } from "vitest";

import { combineMetricAcrossPlatforms, isMetricCombinableAcrossPlatforms, REPORT_METRIC_COMPATIBILITY } from "./metric-compatibility";

describe("metric-compatibility", () => {
  it("marks publishedContentCount combinable and every interaction/audience metric incompatible", () => {
    expect(isMetricCombinableAcrossPlatforms("publishedContentCount")).toBe(true);
    for (const metricId of ["views", "engagement", "likes", "comments", "followers", "subscribers", "reach", "impressions"] as const) {
      expect(isMetricCombinableAcrossPlatforms(metricId)).toBe(false);
    }
  });

  it("every registry entry carries a non-empty reason", () => {
    for (const entry of Object.values(REPORT_METRIC_COMPATIBILITY)) {
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });

  it("combines a compatible metric, summing only known values (missing != zero)", () => {
    const outcome = combineMetricAcrossPlatforms("publishedContentCount", { instagram: 5, youtube: 3 });
    expect(outcome).toEqual({ combined: true, value: 8 });
  });

  it("treats an all-null combinable metric as combined-null, never zero", () => {
    const outcome = combineMetricAcrossPlatforms("publishedContentCount", { instagram: null, youtube: null });
    expect(outcome).toEqual({ combined: true, value: null });
  });

  it("excludes a null platform value from the sum rather than coercing it to zero", () => {
    const outcome = combineMetricAcrossPlatforms("publishedContentCount", { instagram: 10, youtube: null });
    expect(outcome).toEqual({ combined: true, value: 10 });
  });

  it("refuses to combine an incompatible metric and states why", () => {
    const outcome = combineMetricAcrossPlatforms("views", { instagram: 100, youtube: 200 });
    expect(outcome.combined).toBe(false);
    if (!outcome.combined) expect(outcome.reason).toMatch(/instagram|youtube|platform/i);
  });

  it("followers/subscribers are never combinable even with real values", () => {
    expect(combineMetricAcrossPlatforms("followers", { instagram: 1000, youtube: 2000 }).combined).toBe(false);
    expect(combineMetricAcrossPlatforms("subscribers", { instagram: 1000, youtube: 2000 }).combined).toBe(false);
  });
});
