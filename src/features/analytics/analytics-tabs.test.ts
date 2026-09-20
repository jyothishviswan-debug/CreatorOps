import { describe, expect, it } from "vitest";

import { isModuleTabActive } from "@/ui/module-tabs-active";

import { ANALYTICS_PARTNER_DETAIL_PREFIX, ANALYTICS_TABS } from "./analytics-tabs";

describe("ANALYTICS_TABS - the one shared Analytics sub-navigation (Step 12F: six first-class tabs)", () => {
  it("is exactly Overview | Instagram | YouTube | Partners | Data Explorer | Import History, in order", () => {
    expect(ANALYTICS_TABS.map((t) => t.label)).toEqual(["Overview", "Instagram", "YouTube", "Partners", "Data Explorer", "Import History"]);
  });
  it("routes to the six Analytics pages", () => {
    expect(ANALYTICS_TABS.map((t) => t.href)).toEqual(["/analytics", "/analytics/instagram", "/analytics/youtube", "/analytics/partners", "/analytics/explorer", "/analytics/import-history"]);
  });
  it("has unique hrefs and never an import entry (Import execution stays in Import Center)", () => {
    expect(new Set(ANALYTICS_TABS.map((t) => t.href)).size).toBe(ANALYTICS_TABS.length);
    expect(ANALYTICS_TABS.some((t) => t.href.startsWith("/imports"))).toBe(false);
  });
  it("all six are equal first-class tabs: only the plain label / href / Partners' parent prefix exist - no group, separator, spacer or extra field", () => {
    for (const tab of ANALYTICS_TABS) expect(Object.keys(tab).filter((key) => !["label", "href", "activePrefixes"].includes(key))).toEqual([]);
    expect(ANALYTICS_TABS.filter((tab) => tab.activePrefixes !== undefined).map((tab) => tab.label)).toEqual(["Partners"]);
  });
});

describe("isModuleTabActive - the shared 'which tab is current' rule", () => {
  const partners = ANALYTICS_TABS.find((tab) => tab.label === "Partners")!;
  const activeLabels = (pathname: string) => ANALYTICS_TABS.filter((tab) => isModuleTabActive(pathname, tab)).map((tab) => tab.label);

  it("marks exactly the matching tab on each of the six routes", () => {
    for (const tab of ANALYTICS_TABS) expect(activeLabels(tab.href)).toEqual([tab.label]);
  });
  it("marks Partners as the parent / current tab on the Partner drill-down and nothing else", () => {
    expect(ANALYTICS_PARTNER_DETAIL_PREFIX).toBe("/analytics/partner/");
    expect(activeLabels("/analytics/partner/abc123")).toEqual(["Partners"]);
    expect(activeLabels("/analytics/partner/some-ref-with-dashes")).toEqual(["Partners"]);
  });
  it("does not mark Partners on unrelated paths (no loose prefix match)", () => {
    expect(activeLabels("/analytics/partnerx")).toEqual([]);
    expect(activeLabels("/analytics/partner")).toEqual([]);
    expect(activeLabels("/partners")).toEqual([]);
    expect(activeLabels("/analytics/explorer/extra")).toEqual([]);
    expect(activeLabels("/analytics/instagram/anything")).toEqual([]);
  });
  it("the default behavior for a tab WITHOUT activePrefixes (every other module) is unchanged: exact pathname equality only", () => {
    const plain = { label: "Overview", href: "/finance" };
    expect(isModuleTabActive("/finance", plain)).toBe(true);
    expect(isModuleTabActive("/finance/invoices", plain)).toBe(false);
    expect(isModuleTabActive("/finance/", plain)).toBe(false);
    expect(isModuleTabActive("/other", plain)).toBe(false);
    expect(isModuleTabActive(null, plain)).toBe(false);
    expect(isModuleTabActive(undefined, plain)).toBe(false);
    expect(isModuleTabActive("/analytics/partner/x", { ...plain, href: "/analytics/partners" })).toBe(false);
    expect(isModuleTabActive("/analytics/partner/x", partners)).toBe(true);
  });
});
