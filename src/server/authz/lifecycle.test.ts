import { describe, expect, it } from "vitest";

import { canTransitionLifecycle, CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS, CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS, LEAD_LIFECYCLE_TRANSITIONS } from "./lifecycle";

describe("canTransitionLifecycle", () => {
  it("allows a transition from a listed predecessor state", () => {
    expect(canTransitionLifecycle("SUBMITTED", "APPROVED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(true);
  });

  it("denies a transition that skips a required intermediate state", () => {
    expect(canTransitionLifecycle("PLANNED", "POSTED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(false);
  });

  it("denies a transition into an unrecognized state", () => {
    expect(canTransitionLifecycle("SUBMITTED", "ARCHIVED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(false);
  });
});

// Step 11A: the canonical Content lifecycle - two separate transition
// graphs, one per review policy (see lifecycle.ts's own comment).
describe("CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS", () => {
  it("allows the main REVIEW_REQUIRED path one state at a time", () => {
    expect(canTransitionLifecycle("PLANNED", "IN_PRODUCTION", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("IN_PRODUCTION", "SUBMITTED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("SUBMITTED", "APPROVED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("APPROVED", "POSTED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("POSTED", "COMPLETED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(true);
  });

  it("allows the CHANGES_REQUIRED revision loop back to SUBMITTED", () => {
    expect(canTransitionLifecycle("SUBMITTED", "CHANGES_REQUIRED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("CHANGES_REQUIRED", "SUBMITTED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(true);
  });

  it("never allows POSTED before APPROVED", () => {
    expect(canTransitionLifecycle("SUBMITTED", "POSTED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(false);
    expect(canTransitionLifecycle("IN_PRODUCTION", "POSTED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(false);
  });

  it("CANCELLED is reachable from every pre-POSTED state including REJECTED, never from POSTED/COMPLETED", () => {
    for (const from of ["PLANNED", "IN_PRODUCTION", "SUBMITTED", "CHANGES_REQUIRED", "APPROVED", "REJECTED"]) {
      expect(canTransitionLifecycle(from, "CANCELLED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(true);
    }
    expect(canTransitionLifecycle("POSTED", "CANCELLED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(false);
    expect(canTransitionLifecycle("COMPLETED", "CANCELLED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)).toBe(false);
  });
});

describe("CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS", () => {
  it("allows the compact NO_PREPOST_REVIEW path one state at a time", () => {
    expect(canTransitionLifecycle("PLANNED", "IN_PRODUCTION", CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("IN_PRODUCTION", "POSTED", CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("POSTED", "COMPLETED", CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(true);
  });

  it("can never enter any review state - the keys are structurally absent, not merely empty", () => {
    for (const reviewState of ["SUBMITTED", "CHANGES_REQUIRED", "APPROVED", "REJECTED"]) {
      expect(Object.keys(CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS)).not.toContain(reviewState);
      expect(canTransitionLifecycle("IN_PRODUCTION", reviewState, CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(false);
      expect(canTransitionLifecycle("PLANNED", reviewState, CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(false);
    }
  });

  it("CANCELLED is reachable only pre-POSTED", () => {
    expect(canTransitionLifecycle("PLANNED", "CANCELLED", CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("IN_PRODUCTION", "CANCELLED", CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("POSTED", "CANCELLED", CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(false);
    expect(canTransitionLifecycle("COMPLETED", "CANCELLED", CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(false);
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
