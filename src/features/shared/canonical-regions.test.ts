import { describe, expect, it } from "vitest";

import { CANONICAL_REGIONS, isCanonicalRegion, matchCanonicalRegion, REGION_GROUPS } from "./canonical-regions";

describe("canonical regions", () => {
  it("groups every canonical region under its zone", () => {
    expect(REGION_GROUPS.length).toBe(4);
    expect(REGION_GROUPS.flatMap((group) => group.regions)).toEqual([...CANONICAL_REGIONS]);
    expect(isCanonicalRegion("Karnataka")).toBe(true);
    expect(isCanonicalRegion("karnataka")).toBe(false);
  });

  it("matches a stated state to exactly one canonical name", () => {
    expect(matchCanonicalRegion("Karnataka")).toBe("Karnataka");
    expect(matchCanonicalRegion("KARNATAKA")).toBe("Karnataka");
    expect(matchCanonicalRegion("Bengaluru, Karnataka 560001")).toBe("Karnataka");
    expect(matchCanonicalRegion("Andaman and Nicobar")).toBe("Andaman & Nicobar");
    expect(matchCanonicalRegion("  tamil   nadu ")).toBe("Tamil Nadu");
  });

  it("never guesses: a misspelling, nothing, or several states is null", () => {
    expect(matchCanonicalRegion("Karnatak")).toBeNull();
    expect(matchCanonicalRegion("Mumbai")).toBeNull();
    expect(matchCanonicalRegion("Kerala and Karnataka")).toBeNull();
    expect(matchCanonicalRegion("")).toBeNull();
    expect(matchCanonicalRegion(null)).toBeNull();
    expect(matchCanonicalRegion(undefined)).toBeNull();
  });
});
