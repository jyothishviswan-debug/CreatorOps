import { describe, expect, it } from "vitest";

import { DETAIL_TABS, DETAIL_TAB_LABELS, detailHref, intakeHref, parseDetailTab, parseVersionParam, tabKeyTarget } from "./detail-model";

describe("detail tabs", () => {
  it("are exactly Overview | Terms | Verification | KYC | Versions | Activity, in order", () => {
    expect(DETAIL_TABS.map((tab) => DETAIL_TAB_LABELS[tab])).toEqual(["Overview", "Terms", "Verification", "KYC", "Versions", "Activity"]);
  });

  it("parseDetailTab accepts each tab and falls back to overview for anything unusable", () => {
    for (const tab of DETAIL_TABS) expect(parseDetailTab(tab)).toBe(tab);
    expect(parseDetailTab("TERMS")).toBe("terms");
    expect(parseDetailTab(["kyc", "terms"])).toBe("kyc");
    expect(parseDetailTab(" activity ")).toBe("activity");
    for (const raw of [undefined, null, "", "nope", "__proto__", [], ["zzz"]]) expect(parseDetailTab(raw as string | string[] | undefined)).toBe("overview");
  });

  it("tabKeyTarget wraps with arrow keys, jumps with Home / End and ignores other keys", () => {
    expect(tabKeyTarget("overview", "ArrowRight")).toBe("terms");
    expect(tabKeyTarget("activity", "ArrowRight")).toBe("overview");
    expect(tabKeyTarget("overview", "ArrowLeft")).toBe("activity");
    expect(tabKeyTarget("terms", "Home")).toBe("overview");
    expect(tabKeyTarget("terms", "End")).toBe("activity");
    expect(tabKeyTarget("terms", "Enter")).toBeNull();
    expect(tabKeyTarget("terms", "a")).toBeNull();
  });
});

describe("parseVersionParam", () => {
  it("distinguishes absent, valid and invalid", () => {
    expect(parseVersionParam(undefined)).toEqual({ state: "absent" });
    expect(parseVersionParam("")).toEqual({ state: "absent" });
    expect(parseVersionParam("3")).toEqual({ state: "valid", version: 3 });
    expect(parseVersionParam(["12", "4"])).toEqual({ state: "valid", version: 12 });
    expect(parseVersionParam("200")).toEqual({ state: "valid", version: 200 });
  });

  it("never guesses: signs, decimals, zero, huge, padded and junk values are invalid", () => {
    for (const raw of ["0", "-1", "1.5", "1e2", " 2", "2 ", "007", "201", "99999", "abc", "1;drop"]) expect(parseVersionParam(raw)).toEqual({ state: "invalid" });
  });
});

describe("hrefs", () => {
  it("detailHref omits the default tab and encodes the ref", () => {
    expect(detailHref("agr_abc")).toBe("/finance/agreements/agr_abc");
    expect(detailHref("agr_abc", { tab: "overview" })).toBe("/finance/agreements/agr_abc");
    expect(detailHref("agr_abc", { tab: "terms", version: 2 })).toBe("/finance/agreements/agr_abc?tab=terms&version=2");
    expect(detailHref("a b/c")).toBe("/finance/agreements/a%20b%2Fc");
  });

  it("intakeHref links the editor with the agreement, the version and an optional anchor", () => {
    expect(intakeHref("agr_abc", 2)).toBe("/finance/agreements/new?agreementRef=agr_abc&version=2");
    expect(intakeHref("agr_abc", null)).toBe("/finance/agreements/new?agreementRef=agr_abc");
    expect(intakeHref("agr_abc", 1, "field-currency")).toBe("/finance/agreements/new?agreementRef=agr_abc&version=1#field-currency");
  });
});
