import { describe, expect, it } from "vitest";

import { QUALIFYING_UNIT_SELECT_OPTIONS, mapQualifyingUnit, qualifyingPairIssue } from "./qualifying-unit";

describe("mapQualifyingUnit", () => {
  it("accepts exactly the two supported units with their human labels", () => {
    expect(mapQualifyingUnit("approved_content_thread")).toEqual({ state: "SUPPORTED", value: "approved_content_thread", label: "Approved Content" });
    expect(mapQualifyingUnit("approved_current_link")).toEqual({ state: "SUPPORTED", value: "approved_current_link", label: "Approved current link" });
  });

  it("NEVER silently maps unsupported wording: it is kept as written and marked Needs mapping", () => {
    for (const wording of ["reel", "video", "Reel", "post", "approved content", "approved_content", "APPROVED_CONTENT_THREAD"]) {
      expect(mapQualifyingUnit(wording)).toEqual({ state: "NEEDS_MAPPING", extractedWording: wording });
    }
    expect(mapQualifyingUnit("  reel  ")).toEqual({ state: "NEEDS_MAPPING", extractedWording: "reel" });
  });

  it("treats empty / non-string values as no unit", () => {
    for (const empty of [null, undefined, "", "   ", 3, {}, []]) expect(mapQualifyingUnit(empty)).toEqual({ state: "NONE" });
  });
});

describe("the dropdown", () => {
  it("offers only the two supported units (no free text)", () => {
    expect(QUALIFYING_UNIT_SELECT_OPTIONS).toEqual([
      { value: "approved_content_thread", label: "Approved Content" },
      { value: "approved_current_link", label: "Approved current link" },
    ]);
  });
});

describe("qualifyingPairIssue - count and unit go together", () => {
  it("is fine when both are stated (supported unit) or neither", () => {
    expect(qualifyingPairIssue(4, "approved_content_thread")).toBeNull();
    expect(qualifyingPairIssue(0, "approved_current_link")).toBeNull();
    expect(qualifyingPairIssue(null, null)).toBeNull();
  });
  it("a count needs a unit; a unit needs a count", () => {
    expect(qualifyingPairIssue(4, null)).toMatchObject({ fieldKey: "qualifyingUnit" });
    expect(qualifyingPairIssue(null, "approved_current_link")).toMatchObject({ fieldKey: "monthlyRequiredQualifyingContentCount" });
  });
  it("an unsupported unit is an issue on the unit", () => {
    expect(qualifyingPairIssue(4, "reel")).toMatchObject({ fieldKey: "qualifyingUnit" });
  });
});
