import { describe, expect, it } from "vitest";

import { ANALYTICS_TABS } from "./analytics-tabs";

describe("ANALYTICS_TABS - the one shared Analytics sub-navigation", () => {
  it("is exactly Overview | Instagram | YouTube | Data Explorer | Import History, in order", () => {
    expect(ANALYTICS_TABS.map((t) => t.label)).toEqual(["Overview", "Instagram", "YouTube", "Data Explorer", "Import History"]);
  });
  it("routes to the five Analytics pages", () => {
    expect(ANALYTICS_TABS.map((t) => t.href)).toEqual(["/analytics", "/analytics/instagram", "/analytics/youtube", "/analytics/explorer", "/analytics/import-history"]);
  });
  it("has unique hrefs and never an import entry (Import execution stays in Import Center)", () => {
    expect(new Set(ANALYTICS_TABS.map((t) => t.href)).size).toBe(ANALYTICS_TABS.length);
    expect(ANALYTICS_TABS.some((t) => t.href.startsWith("/imports"))).toBe(false);
  });
});
