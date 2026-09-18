import { describe, expect, it } from "vitest";

import { canTransitionLifecycle, CONTENT_LIFECYCLE_TRANSITIONS, LEAD_LIFECYCLE_TRANSITIONS } from "./lifecycle";

describe("canTransitionLifecycle", () => {
  it("allows a transition from a listed predecessor state", () => {
    expect(canTransitionLifecycle("UNDER_REVIEW", "APPROVED", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(true);
  });

  it("denies a transition that skips a required intermediate state", () => {
    expect(canTransitionLifecycle("OPEN", "APPROVED", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(false);
  });

  it("denies a transition into an unrecognized state", () => {
    expect(canTransitionLifecycle("UNDER_REVIEW", "ARCHIVED", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(false);
  });
});

// Step 11A.1: the canonical Content lifecycle - ONE transition graph,
// replacing the retired two-policy production/pre-publication-review/
// publication/completion model entirely (see lifecycle.ts's own
// comment). OPEN -> UNDER_REVIEW -> APPROVED is the only mainline;
// REVISION_REQUESTED loops back to UNDER_REVIEW on resubmission.
describe("CONTENT_LIFECYCLE_TRANSITIONS", () => {
  it("OPEN has no predecessor - it is only ever the initial state on thread creation", () => {
    expect(Object.keys(CONTENT_LIFECYCLE_TRANSITIONS.OPEN ?? []).length).toBe(0);
    for (const state of Object.keys(CONTENT_LIFECYCLE_TRANSITIONS)) {
      expect(canTransitionLifecycle(state, "OPEN", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(false);
    }
  });

  it("OPEN -> UNDER_REVIEW only via the public submit route (this table's own caller never invokes it directly, but the edge itself is legal)", () => {
    expect(canTransitionLifecycle("OPEN", "UNDER_REVIEW", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(true);
  });

  it("UNDER_REVIEW's two Manager decisions: APPROVED (closes) or REVISION_REQUESTED (reopens)", () => {
    expect(canTransitionLifecycle("UNDER_REVIEW", "APPROVED", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("UNDER_REVIEW", "REVISION_REQUESTED", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(true);
  });

  it("REVISION_REQUESTED loops back to UNDER_REVIEW on resubmission, never directly to APPROVED", () => {
    expect(canTransitionLifecycle("REVISION_REQUESTED", "UNDER_REVIEW", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("REVISION_REQUESTED", "APPROVED", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(false);
  });

  it("APPROVED is finality - never reachable again, and CANCELLED never lists it as a predecessor", () => {
    expect(canTransitionLifecycle("APPROVED", "UNDER_REVIEW", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(false);
    expect(canTransitionLifecycle("APPROVED", "CANCELLED", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(false);
    expect(CONTENT_LIFECYCLE_TRANSITIONS.CANCELLED).not.toContain("APPROVED");
  });

  it("CANCELLED is reachable from OPEN/UNDER_REVIEW/REVISION_REQUESTED, never from APPROVED", () => {
    for (const from of ["OPEN", "UNDER_REVIEW", "REVISION_REQUESTED"]) {
      expect(canTransitionLifecycle(from, "CANCELLED", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(true);
    }
    expect(canTransitionLifecycle("APPROVED", "CANCELLED", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(false);
  });

  it("CANCELLED itself is terminal - nothing lists it as an allowed predecessor of anything", () => {
    for (const state of Object.keys(CONTENT_LIFECYCLE_TRANSITIONS)) {
      expect(canTransitionLifecycle("CANCELLED", state, CONTENT_LIFECYCLE_TRANSITIONS)).toBe(false);
    }
  });
});

// Step 6A: the frozen greenfield compact Discovery Lead lifecycle.
describe("LEAD_LIFECYCLE_TRANSITIONS", () => {
  it("allows the strict linear main-path sequence, one state at a time", () => {
    expect(canTransitionLifecycle("NEW", "RESEARCHING", LEAD_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("RESEARCHING", "CONTACTED", LEAD_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("CONTACTED", "RESPONDED", LEAD_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("RESPONDED", "EVALUATING", LEAD_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("EVALUATING", "CONVERSION_READY", LEAD_LIFECYCLE_TRANSITIONS)).toBe(true);
  });

  it("denies skipping an intermediate main-path state", () => {
    expect(canTransitionLifecycle("NEW", "CONTACTED", LEAD_LIFECYCLE_TRANSITIONS)).toBe(false);
    expect(canTransitionLifecycle("RESEARCHING", "RESPONDED", LEAD_LIFECYCLE_TRANSITIONS)).toBe(false);
    expect(canTransitionLifecycle("NEW", "CONVERSION_READY", LEAD_LIFECYCLE_TRANSITIONS)).toBe(false);
  });

  it("denies moving backward along the main path", () => {
    expect(canTransitionLifecycle("CONTACTED", "RESEARCHING", LEAD_LIFECYCLE_TRANSITIONS)).toBe(false);
    expect(canTransitionLifecycle("CONVERSION_READY", "EVALUATING", LEAD_LIFECYCLE_TRANSITIONS)).toBe(false);
  });

  it("CONVERTED is never reachable through this generic table, even from CONVERSION_READY", () => {
    expect(canTransitionLifecycle("CONVERSION_READY", "CONVERTED", LEAD_LIFECYCLE_TRANSITIONS)).toBe(false);
  });

  it("WATCHLIST/REJECTED are reachable from any active pre-conversion state", () => {
    for (const from of ["NEW", "RESEARCHING", "CONTACTED", "RESPONDED", "EVALUATING", "CONVERSION_READY"]) {
      expect(canTransitionLifecycle(from, "WATCHLIST", LEAD_LIFECYCLE_TRANSITIONS)).toBe(true);
      expect(canTransitionLifecycle(from, "REJECTED", LEAD_LIFECYCLE_TRANSITIONS)).toBe(true);
    }
  });

  it("ARCHIVED and DUPLICATE are also reachable directly from WATCHLIST/REJECTED (no forced restore round-trip)", () => {
    expect(canTransitionLifecycle("WATCHLIST", "ARCHIVED", LEAD_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("REJECTED", "ARCHIVED", LEAD_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("WATCHLIST", "DUPLICATE", LEAD_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("REJECTED", "DUPLICATE", LEAD_LIFECYCLE_TRANSITIONS)).toBe(true);
  });

  it("DUPLICATE and CONVERTED are terminal - nothing lists either as an allowed predecessor of anything", () => {
    for (const state of Object.keys(LEAD_LIFECYCLE_TRANSITIONS)) {
      expect(canTransitionLifecycle("DUPLICATE", state, LEAD_LIFECYCLE_TRANSITIONS)).toBe(false);
      expect(canTransitionLifecycle("CONVERTED", state, LEAD_LIFECYCLE_TRANSITIONS)).toBe(false);
    }
  });

  it("NEW has no valid predecessor - it is only ever the initial state on creation", () => {
    for (const state of Object.keys(LEAD_LIFECYCLE_TRANSITIONS)) {
      expect(canTransitionLifecycle(state, "NEW", LEAD_LIFECYCLE_TRANSITIONS)).toBe(false);
    }
  });
});
