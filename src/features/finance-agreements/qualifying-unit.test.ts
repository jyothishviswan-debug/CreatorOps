import { describe, expect, it } from "vitest";

import { mapQualifyingUnit, qualifyingPairIssue, qualifyingUnitSelectOptions } from "./qualifying-unit";

describe("mapQualifyingUnit", () => {
  it("accepts the current unit and the two legacy units (backward compat) with their human labels", () => {
    expect(mapQualifyingUnit("qualifying_analytics_post")).toEqual({ state: "SUPPORTED", value: "qualifying_analytics_post", label: "Monthly required posts/content" });
    expect(mapQualifyingUnit("approved_content_thread")).toEqual({ state: "SUPPORTED", value: "approved_content_thread", label: "Approved Content (legacy)" });
    expect(mapQualifyingUnit("approved_current_link")).toEqual({ state: "SUPPORTED", value: "approved_current_link", label: "Approved current link (legacy)" });
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

// Findings #30/#66 (user-decided): the confirmation control never offers a technical choice between
// internal implementation concepts - a new/unset/already-current field sees exactly ONE option; only a
// field already confirmed on a LEGACY unit additionally keeps its own existing option present (so an
// existing value is never silently blanked out), and that legacy option is never offered to anything else.
describe("qualifyingUnitSelectOptions - the confirmation control's own options", () => {
  it("a brand-new/unset field sees exactly one option: the current unit", () => {
    expect(qualifyingUnitSelectOptions(null)).toEqual([{ value: "qualifying_analytics_post", label: "Monthly required posts/content" }]);
    expect(qualifyingUnitSelectOptions(undefined)).toEqual([{ value: "qualifying_analytics_post", label: "Monthly required posts/content" }]);
    expect(qualifyingUnitSelectOptions("")).toEqual([{ value: "qualifying_analytics_post", label: "Monthly required posts/content" }]);
  });

  it("a field already on the current unit still sees exactly one option (itself) - never a legacy choice", () => {
    expect(qualifyingUnitSelectOptions("qualifying_analytics_post")).toEqual([{ value: "qualifying_analytics_post", label: "Monthly required posts/content" }]);
  });

  it("a field already confirmed on a legacy unit keeps its OWN existing option present, alongside the current one - never blanked", () => {
    expect(qualifyingUnitSelectOptions("approved_content_thread")).toEqual([
      { value: "qualifying_analytics_post", label: "Monthly required posts/content" },
      { value: "approved_content_thread", label: "Approved Content (legacy)" },
    ]);
    expect(qualifyingUnitSelectOptions("approved_current_link")).toEqual([
      { value: "qualifying_analytics_post", label: "Monthly required posts/content" },
      { value: "approved_current_link", label: "Approved current link (legacy)" },
    ]);
  });

  it("an unrecognized wording extracted from a contract is never offered as its own option (a free-text noun is never selectable)", () => {
    expect(qualifyingUnitSelectOptions("reel")).toEqual([{ value: "qualifying_analytics_post", label: "Monthly required posts/content" }]);
  });
});

describe("qualifyingPairIssue - count and unit go together", () => {
  it("is fine when both are stated (supported unit) or neither", () => {
    expect(qualifyingPairIssue(4, "qualifying_analytics_post")).toBeNull();
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
