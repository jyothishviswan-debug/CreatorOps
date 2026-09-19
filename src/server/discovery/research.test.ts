import { describe, expect, it } from "vitest";

import { isApprovedTargetAudience, isResearchComplete } from "./research";
import type { LeadResearch } from "./types";

function research(overrides: Partial<LeadResearch>): LeadResearch {
  return { targetAudience: [], updatedAt: "2026-01-01T00:00:00.000Z", updatedByUserRef: "ref-1", ...overrides };
}

describe("isApprovedTargetAudience", () => {
  it("accepts every one of the five exact approved values", () => {
    for (const value of ["India Alpha", "India 1", "India 2", "India 3", "India 4"]) {
      expect(isApprovedTargetAudience(value)).toBe(true);
    }
  });

  it("rejects values that are not on the approved list, even close variants", () => {
    for (const value of ["Pan India", "Regional", "Local/City", "Other", "india 1", "India 5", "", null, undefined]) {
      expect(isApprovedTargetAudience(value)).toBe(false);
    }
  });
});

describe("isResearchComplete - the one shared canonical Research-completion function", () => {
  it("is complete when exactly one approved Target Audience is recorded, with no other fields at all", () => {
    expect(isResearchComplete(research({ targetAudience: ["India 1"] }))).toBe(true);
  });

  it("is complete when more than one approved Target Audience is recorded (a Lead may span more than one segment)", () => {
    expect(isResearchComplete(research({ targetAudience: ["India 1", "India Alpha"] }))).toBe(true);
  });

  it("is incomplete when there is no research record at all", () => {
    expect(isResearchComplete(null)).toBe(false);
  });

  it("is incomplete when targetAudience is an empty array, no matter how much optional context is filled in", () => {
    const thorough = research({
      targetAudience: [],
      language: "Malayalam",
      location: "Kochi",
      category: "Travel",
      notes: "Extremely detailed research notes.",
      followerCount: 500_000,
    });
    expect(isResearchComplete(thorough)).toBe(false);
  });

  it("is incomplete when targetAudience contains only disallowed/unapproved-looking values", () => {
    expect(isResearchComplete(research({ targetAudience: ["Pan India", "Regional"] as never }))).toBe(false);
  });
});
