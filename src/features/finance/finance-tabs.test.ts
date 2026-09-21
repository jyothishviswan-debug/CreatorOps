import { describe, expect, it } from "vitest";

import { isModuleTabActive } from "@/ui/module-tabs-active";

import { FINANCE_AGREEMENTS_HREF, FINANCE_EYEBROW, FINANCE_TABS } from "./finance-tabs";

const activeLabels = (pathname: string) => FINANCE_TABS.filter((tab) => isModuleTabActive(pathname, tab)).map((tab) => tab.label);

describe("FINANCE_TABS - the one shared Finance module navigation", () => {
  it("is exactly Overview | Agreements | Payables | Invoices | Payments, in order, with the original routes", () => {
    expect(FINANCE_TABS.map((tab) => tab.label)).toEqual(["Overview", "Agreements", "Payables", "Invoices", "Payments"]);
    expect(FINANCE_TABS.map((tab) => tab.href)).toEqual(["/finance", "/finance/agreements", "/finance/payables", "/finance/invoices", "/finance/payments"]);
  });

  it("has unique hrefs and no field other than label / href / activePrefixes (no duplicate or extra navigation)", () => {
    expect(new Set(FINANCE_TABS.map((tab) => tab.href)).size).toBe(FINANCE_TABS.length);
    for (const tab of FINANCE_TABS) expect(Object.keys(tab).filter((key) => !["label", "href", "activePrefixes"].includes(key))).toEqual([]);
  });

  it("only Agreements declares activePrefixes, and it is exactly the Agreements prefix", () => {
    expect(FINANCE_TABS.filter((tab) => tab.activePrefixes !== undefined).map((tab) => tab.label)).toEqual(["Agreements"]);
    expect(FINANCE_TABS.find((tab) => tab.label === "Agreements")?.activePrefixes).toEqual([FINANCE_AGREEMENTS_HREF]);
  });

  it("marks exactly the matching tab on each of the five routes", () => {
    for (const tab of FINANCE_TABS) expect(activeLabels(tab.href)).toEqual([tab.label]);
  });

  it("keeps Agreements current on its nested routes (new, detail, detail with a query-free path)", () => {
    expect(activeLabels("/finance/agreements/new")).toEqual(["Agreements"]);
    expect(activeLabels("/finance/agreements/agr_0123456789abcdef0123")).toEqual(["Agreements"]);
  });

  it("does not mark any other tab on the nested Agreements routes, nor Agreements on the other Finance routes", () => {
    expect(activeLabels("/finance/agreements/new")).not.toContain("Overview");
    expect(activeLabels("/finance")).toEqual(["Overview"]);
    expect(activeLabels("/finance/payables")).toEqual(["Payables"]);
    expect(activeLabels("/finance/invoices")).toEqual(["Invoices"]);
    expect(activeLabels("/finance/payments")).toEqual(["Payments"]);
  });

  it("the other four tabs keep the default exact-match behavior", () => {
    expect(activeLabels("/finance/payables/anything")).toEqual([]);
    expect(activeLabels("/finance/")).toEqual([]);
    expect(activeLabels("/partners")).toEqual([]);
  });

  it("keeps the eyebrow every Finance page has always used", () => {
    expect(FINANCE_EYEBROW).toBe("FINANCE & SETTLE");
  });
});
