import { describe, expect, it } from "vitest";

import { sameNormalizedSet } from "./format";

// Finding #34: the Detail page's own "no duplicate platform display" rule (a legacy
// "Targeting platforms" row is shown only when it genuinely diverges from the canonical
// Platforms) relies entirely on this comparison being order- and duplicate-independent.
describe("sameNormalizedSet", () => {
  it("identical sets in the same order match", () => {
    expect(sameNormalizedSet(["instagram", "youtube"], ["instagram", "youtube"])).toBe(true);
  });

  it("identical sets in a different order still match", () => {
    expect(sameNormalizedSet(["instagram", "youtube"], ["youtube", "instagram"])).toBe(true);
  });

  it("two empty sets match", () => {
    expect(sameNormalizedSet([], [])).toBe(true);
  });

  it("a genuinely different set does not match", () => {
    expect(sameNormalizedSet(["instagram", "youtube"], ["instagram"])).toBe(false);
    expect(sameNormalizedSet(["instagram"], [])).toBe(false);
  });
});
