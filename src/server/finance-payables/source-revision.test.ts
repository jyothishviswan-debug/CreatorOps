import { describe, expect, it } from "vitest";

import { compareSourceVersions, SOURCE_REVISION_MESSAGES, type CurrentSourceVersions, type PinnedSourceVersions } from "./source-revision";
import { PAYABLE_SOURCE_CURRENCY_STATES } from "./types";

// Step 15A section 16: the source-revision comparison is a WARNING and nothing else - a pure
// function over the pinned versions and what governs today. It never mutates a payable.

const PINNED: PinnedSourceVersions = { agreementRef: "agr_0123456789abcdef0123", agreementVersion: 2, sourceReviewRef: "pr_0123456789abcdef0123", sourceReviewVersion: 1 };
const SAME: CurrentSourceVersions = { agreementRef: "agr_0123456789abcdef0123", agreementVersion: 2, reviewRef: "pr_0123456789abcdef0123", reviewVersion: 1 };

describe("the closed state set", () => {
  it("is exactly the four states section 16 names, and every one has a message", () => {
    expect([...PAYABLE_SOURCE_CURRENCY_STATES]).toEqual(["CURRENT", "AGREEMENT_REVISION_AVAILABLE", "REVIEW_REVISION_AVAILABLE", "MULTIPLE_SOURCE_REVISIONS_AVAILABLE"]);
    for (const state of PAYABLE_SOURCE_CURRENCY_STATES) expect(SOURCE_REVISION_MESSAGES[state].length).toBeGreaterThan(20);
  });
});

describe("comparing pinned versions against what governs today", () => {
  it("identical source versions are CURRENT", () => {
    expect(compareSourceVersions(PINNED, SAME)).toEqual({ state: "CURRENT", agreementRevisionAvailable: false, reviewRevisionAvailable: false });
  });

  it("a newer Agreement version is AGREEMENT_REVISION_AVAILABLE", () => {
    expect(compareSourceVersions(PINNED, { ...SAME, agreementVersion: 3 }).state).toBe("AGREEMENT_REVISION_AVAILABLE");
  });

  it("a DIFFERENT Agreement ref also counts as an Agreement revision - the commercial authority changed", () => {
    expect(compareSourceVersions(PINNED, { ...SAME, agreementRef: "agr_ffffffffffffffffffff" }).state).toBe("AGREEMENT_REVISION_AVAILABLE");
  });

  it("a newer finalized Review version is REVIEW_REVISION_AVAILABLE", () => {
    expect(compareSourceVersions(PINNED, { ...SAME, reviewVersion: 2 }).state).toBe("REVIEW_REVISION_AVAILABLE");
  });

  it("both changed is MULTIPLE_SOURCE_REVISIONS_AVAILABLE", () => {
    expect(compareSourceVersions(PINNED, { agreementRef: "agr_0123456789abcdef0123", agreementVersion: 4, reviewRef: "pr_0123456789abcdef0123", reviewVersion: 3 })).toEqual({
      state: "MULTIPLE_SOURCE_REVISIONS_AVAILABLE",
      agreementRevisionAvailable: true,
      reviewRevisionAvailable: true,
    });
  });

  it("an agreement-only payable (no review pinned, none current) compares only the Agreement", () => {
    const pinned: PinnedSourceVersions = { ...PINNED, sourceReviewRef: null, sourceReviewVersion: null };
    expect(compareSourceVersions(pinned, { ...SAME, reviewRef: null, reviewVersion: null }).state).toBe("CURRENT");
    expect(compareSourceVersions(pinned, { ...SAME, agreementVersion: 5, reviewRef: null, reviewVersion: null }).state).toBe("AGREEMENT_REVISION_AVAILABLE");
  });

  it("offers nothing when the current source cannot be resolved at all", () => {
    expect(compareSourceVersions(PINNED, null)).toEqual({ state: "CURRENT", agreementRevisionAvailable: false, reviewRevisionAvailable: false });
  });
});
