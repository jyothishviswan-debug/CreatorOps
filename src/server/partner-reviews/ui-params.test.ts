import { describe, expect, it } from "vitest";

import { derivePeriod } from "./period";
import {
  isMonthKey,
  monthLabel,
  monthWindow,
  parseDetailTab,
  parseFilterParam,
  parseHistoryTab,
  parseLimitParam,
  parseMonthParam,
  parsePartnerRefParam,
  parseRegionParam,
  parseSearchQuery,
  parseSignalParam,
  parseVersionParam,
  partnerHistoryHref,
  previousMonth,
  reviewHref,
  workspaceHref,
} from "./ui-params";

describe("month parameter", () => {
  it("accepts a real YYYY-MM month exactly as given", () => {
    expect(parseMonthParam("2026-03")).toEqual({ state: "valid", month: "2026-03" });
    expect(parseMonthParam(["2026-03", "2019-01"])).toEqual({ state: "valid", month: "2026-03" });
  });

  it("absent / empty is absent; anything unusable is invalid (never silently repaired)", () => {
    expect(parseMonthParam(undefined)).toEqual({ state: "absent" });
    expect(parseMonthParam("")).toEqual({ state: "absent" });
    for (const garbage of ["2026-13", "2026-00", "26-03", "2026-3", "March", "2026-03-01", " 2026-03", "1969-12", "<script>", "2026-03\n"]) {
      expect(parseMonthParam(garbage), garbage).toEqual({ state: "invalid" });
    }
  });

  it("labels, previous month and 12-month windows are calendar-correct across year ends", () => {
    expect(monthLabel("2019-03")).toBe("March 2019");
    expect(monthLabel("nope")).toBe("nope");
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(previousMonth("1970-01")).toBeNull();
    const window = monthWindow("2026-02", 12);
    expect(window).toHaveLength(12);
    expect(window[0]).toBe("2026-02");
    expect(window[11]).toBe("2025-03");
    expect(new Set(window).size).toBe(12);
  });
});

describe("the restated month rule can never drift from the backend's", () => {
  it("isMonthKey equals derivePeriod's validity over a matrix", () => {
    const candidates = ["2026-03", "2026-12", "2026-13", "2026-00", "1969-12", "1970-01", "0999-05", "26-03", "2026-3", "2026-03-01", " 2026-03", "2026-03 ", "abcd-ef", "", "2026-03\n", "9999-12", "1970-1"];
    for (const value of candidates) expect(isMonthKey(value), JSON.stringify(value)).toBe(derivePeriod(value) !== null);
    for (const value of [undefined, null, 202603, {}, []]) expect(isMonthKey(value)).toBe(false);
  });
});

describe("workspace parameters", () => {
  it("filter: only the three real filters, else none", () => {
    expect(parseFilterParam("needs-review")).toBe("needs-review");
    expect(parseFilterParam("drafts")).toBe("drafts");
    expect(parseFilterParam("finalized")).toBe("finalized");
    for (const garbage of [undefined, "", "all", "DRAFTS", "drafts;", ["x"]]) expect(parseFilterParam(garbage as never)).toBeNull();
  });

  it("signal: only the closed list", () => {
    expect(parseSignalParam("late")).toBe("late");
    expect(parseSignalParam("score")).toBeNull();
    expect(parseSignalParam(undefined)).toBeNull();
  });

  it("search query is trimmed and bounded; regions are de-duplicated and bounded; partnerRef rejects path-like values", () => {
    expect(parseSearchQuery("  ann  ")).toBe("ann");
    expect(parseSearchQuery("x".repeat(500))).toHaveLength(80);
    expect(parseRegionParam(["Kerala", "Kerala", " ", "Goa"])).toEqual(["Kerala", "Goa"]);
    expect(parseRegionParam(Array.from({ length: 40 }, (_, i) => `R${i}`))).toHaveLength(10);
    expect(parseRegionParam("Kerala")).toEqual(["Kerala"]);
    expect(parsePartnerRefParam("partner-abc")).toBe("partner-abc");
    for (const bad of ["a/b", "a b", "", undefined]) expect(parsePartnerRefParam(bad as never)).toBeUndefined();
  });

  it("limit is a positive integer capped at 20, defaulting to 10", () => {
    expect(parseLimitParam(undefined)).toBe(10);
    expect(parseLimitParam("5")).toBe(5);
    expect(parseLimitParam("500")).toBe(20);
    for (const bad of ["0", "-1", "abc", "1.5"]) expect(parseLimitParam(bad)).toBe(10);
  });
});

describe("detail and history parameters", () => {
  it("tab: the five detail tabs / six history tabs, else the default", () => {
    for (const tab of ["overview", "production", "compliance", "performance", "history"]) expect(parseDetailTab(tab)).toBe(tab);
    expect(parseDetailTab("finance")).toBe("overview");
    for (const tab of ["trend", "production", "compliance", "performance", "commercial", "history"]) expect(parseHistoryTab(tab)).toBe(tab);
    expect(parseHistoryTab("nope")).toBe("trend");
  });

  it("version: a positive integer, else absent/invalid", () => {
    expect(parseVersionParam("2")).toEqual({ state: "valid", version: 2 });
    expect(parseVersionParam(undefined)).toEqual({ state: "absent" });
    for (const bad of ["0", "-1", "1.5", "abc", "99999", "1e3"]) expect(parseVersionParam(bad), bad).toEqual({ state: "invalid" });
  });
});

describe("href builders", () => {
  it("build the documented URL shapes and omit defaults", () => {
    expect(workspaceHref()).toBe("/partner-reviews/workspace");
    expect(workspaceHref({ filter: "drafts", month: "2019-03" })).toBe("/partner-reviews/workspace?filter=drafts&month=2019-03");
    expect(workspaceHref({ signal: "late", month: "2019-03", region: ["Kerala", "Goa"] })).toBe("/partner-reviews/workspace?month=2019-03&region=Kerala&region=Goa&signal=late");
    expect(reviewHref("pr_abc")).toBe("/partner-reviews/pr_abc");
    expect(reviewHref("pr_abc", { tab: "production", version: 2 })).toBe("/partner-reviews/pr_abc?tab=production&version=2");
    expect(reviewHref("pr_abc", { tab: "overview" })).toBe("/partner-reviews/pr_abc");
    expect(partnerHistoryHref("p 1", { month: "2019-03", tab: "commercial" })).toBe("/partner-reviews/partner/p%201?month=2019-03&tab=commercial");
    expect(partnerHistoryHref("p1", { tab: "trend" })).toBe("/partner-reviews/partner/p1");
  });
});
