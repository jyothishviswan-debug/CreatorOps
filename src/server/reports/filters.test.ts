import { describe, expect, it } from "vitest";

import { getReportDefinition } from "./catalog";
import { parseAppliedFilters } from "./filters";

describe("parseAppliedFilters (section 7: server-declared allowlist only)", () => {
  const definition = getReportDefinition("campaign_delivery"); // supportedFilters: campaignRef, platform, status

  it("drops any key not declared in the report's own supportedFilters - an arbitrary/unknown filter id never grants access", () => {
    const applied = parseAppliedFilters({ campaignRef: "camp_1", arbitraryField: "whatever", __proto__: "x", ownerUid: "someone" } as Record<string, unknown>, definition);
    expect(applied).toEqual({ campaignRef: "camp_1" });
  });

  it("drops a non-string value even for a declared filter id", () => {
    const applied = parseAppliedFilters({ campaignRef: 12345, status: { nested: true } } as unknown as Record<string, unknown>, definition);
    expect(applied).toEqual({});
  });

  it("trims whitespace and drops an empty or overlong value", () => {
    expect(parseAppliedFilters({ campaignRef: "  camp_1  " }, definition)).toEqual({ campaignRef: "camp_1" });
    expect(parseAppliedFilters({ campaignRef: "   " }, definition)).toEqual({});
    expect(parseAppliedFilters({ campaignRef: "x".repeat(500) }, definition)).toEqual({});
  });

  it("returns an empty object for undefined/non-object input", () => {
    expect(parseAppliedFilters(undefined, definition)).toEqual({});
    expect(parseAppliedFilters(null as unknown as Record<string, unknown>, definition)).toEqual({});
  });

  it("a report's allowlist is exactly its own declared supportedFilters - nothing else", () => {
    const definition = getReportDefinition("monthly_partner_performance");
    expect(parseAppliedFilters({ partnerRef: "p1", notAllowed: "x" }, definition)).toEqual({ partnerRef: "p1" });
  });
});
