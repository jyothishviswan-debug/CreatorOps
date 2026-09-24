import { describe, expect, it } from "vitest";

import { canTransitionLifecycle, CONTENT_LIFECYCLE_TRANSITIONS, FINANCE_AGREEMENT_LIFECYCLE_TRANSITIONS, INVOICE_LIFECYCLE_TRANSITIONS, LEAD_LIFECYCLE_TRANSITIONS, PARTNER_REVIEW_LIFECYCLE_TRANSITIONS, PAYMENT_LIFECYCLE_TRANSITIONS } from "./lifecycle";

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

// Step 13A: Partner Reviews' version lifecycle. NEEDS_REVIEW is derived,
// never a persisted state, so it has no entry at all.
describe("PARTNER_REVIEW_LIFECYCLE_TRANSITIONS", () => {
  it("is the strict chain DRAFT -> IN_REVIEW -> FINALIZED -> SUPERSEDED", () => {
    expect(canTransitionLifecycle("DRAFT", "IN_REVIEW", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("IN_REVIEW", "FINALIZED", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("FINALIZED", "SUPERSEDED", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(true);
  });

  it("has no shortcut, no reverse edge, and DRAFT is only ever an initial state", () => {
    expect(canTransitionLifecycle("DRAFT", "FINALIZED", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(false);
    expect(canTransitionLifecycle("IN_REVIEW", "SUPERSEDED", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(false);
    expect(canTransitionLifecycle("IN_REVIEW", "DRAFT", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(false);
    expect(canTransitionLifecycle("FINALIZED", "IN_REVIEW", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(false);
    for (const state of Object.keys(PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)) {
      expect(canTransitionLifecycle(state, "DRAFT", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(false);
    }
    expect(canTransitionLifecycle("FINALIZED", "NEEDS_REVIEW", PARTNER_REVIEW_LIFECYCLE_TRANSITIONS)).toBe(false);
  });
});

// Step 14A: Finance Agreement version lifecycle. Confirmation is a field on a
// DRAFT version (not a status), so a confirmed draft activates straight to ACTIVE.
describe("FINANCE_AGREEMENT_LIFECYCLE_TRANSITIONS", () => {
  const T = FINANCE_AGREEMENT_LIFECYCLE_TRANSITIONS;

  it("DRAFT -> ACTIVE (activate), ACTIVE <-> SUSPENDED (suspend/resume), ACTIVE|SUSPENDED -> ENDED", () => {
    expect(canTransitionLifecycle("DRAFT", "ACTIVE", T)).toBe(true);
    expect(canTransitionLifecycle("ACTIVE", "SUSPENDED", T)).toBe(true);
    expect(canTransitionLifecycle("SUSPENDED", "ACTIVE", T)).toBe(true);
    expect(canTransitionLifecycle("ACTIVE", "ENDED", T)).toBe(true);
    expect(canTransitionLifecycle("SUSPENDED", "ENDED", T)).toBe(true);
  });

  it("SUPERSEDED is set only on a previously ACTIVE/SUSPENDED version (never a DRAFT)", () => {
    expect(canTransitionLifecycle("ACTIVE", "SUPERSEDED", T)).toBe(true);
    expect(canTransitionLifecycle("SUSPENDED", "SUPERSEDED", T)).toBe(true);
    expect(canTransitionLifecycle("DRAFT", "SUPERSEDED", T)).toBe(false);
    expect(canTransitionLifecycle("ENDED", "SUPERSEDED", T)).toBe(false);
  });

  it("DRAFT is only ever an initial state; ENDED and SUPERSEDED are terminal; an unactivated DRAFT cannot be suspended or ended", () => {
    for (const state of Object.keys(T)) expect(canTransitionLifecycle(state, "DRAFT", T)).toBe(false);
    for (const terminal of ["ENDED", "SUPERSEDED"]) {
      for (const next of Object.keys(T)) expect(canTransitionLifecycle(terminal, next, T)).toBe(false);
    }
    expect(canTransitionLifecycle("DRAFT", "SUSPENDED", T)).toBe(false);
    expect(canTransitionLifecycle("DRAFT", "ENDED", T)).toBe(false);
    expect(canTransitionLifecycle("ACTIVE", "ACTIVE", T)).toBe(false);
    expect(canTransitionLifecycle("ACTIVE", "CONFIRMED", T)).toBe(false);
  });
});

// Step 16A: Finance Invoice lifecycle. DRAFT -> SUBMITTED -> APPROVED|REJECTED; REJECTED can reopen
// back to a new DRAFT version under the same head; VOID is reasoned and terminal.
describe("INVOICE_LIFECYCLE_TRANSITIONS", () => {
  const T = INVOICE_LIFECYCLE_TRANSITIONS;

  it("DRAFT -> SUBMITTED -> APPROVED|REJECTED", () => {
    expect(canTransitionLifecycle("DRAFT", "SUBMITTED", T)).toBe(true);
    expect(canTransitionLifecycle("SUBMITTED", "APPROVED", T)).toBe(true);
    expect(canTransitionLifecycle("SUBMITTED", "REJECTED", T)).toBe(true);
  });

  it("REJECTED reopens back to a new DRAFT version under the same head", () => {
    expect(canTransitionLifecycle("REJECTED", "DRAFT", T)).toBe(true);
  });

  it("APPROVED is reachable only from SUBMITTED, never directly from DRAFT or REJECTED", () => {
    expect(canTransitionLifecycle("DRAFT", "APPROVED", T)).toBe(false);
    expect(canTransitionLifecycle("REJECTED", "APPROVED", T)).toBe(false);
  });

  it("VOID is reachable from DRAFT/SUBMITTED/REJECTED/APPROVED and is terminal", () => {
    for (const from of ["DRAFT", "SUBMITTED", "REJECTED", "APPROVED"]) expect(canTransitionLifecycle(from, "VOID", T)).toBe(true);
    for (const state of Object.keys(T)) expect(canTransitionLifecycle("VOID", state, T)).toBe(false);
  });

  it("no shortcut skips SUBMITTED, and DRAFT has no other predecessor besides REJECTED", () => {
    expect(canTransitionLifecycle("DRAFT", "REJECTED", T)).toBe(false);
    for (const state of Object.keys(T)) {
      if (state === "REJECTED") continue;
      expect(canTransitionLifecycle(state, "DRAFT", T)).toBe(false);
    }
  });
});

describe("PAYMENT_LIFECYCLE_TRANSITIONS", () => {
  const T = PAYMENT_LIFECYCLE_TRANSITIONS;

  it("DRAFT -> RECORDED -> CONFIRMED|FAILED", () => {
    expect(canTransitionLifecycle("DRAFT", "RECORDED", T)).toBe(true);
    expect(canTransitionLifecycle("RECORDED", "CONFIRMED", T)).toBe(true);
    expect(canTransitionLifecycle("RECORDED", "FAILED", T)).toBe(true);
  });

  it("FAILED reopens back to a new DRAFT version under the same head", () => {
    expect(canTransitionLifecycle("FAILED", "DRAFT", T)).toBe(true);
  });

  it("CONFIRMED is reachable only from RECORDED, never directly from DRAFT or FAILED", () => {
    expect(canTransitionLifecycle("DRAFT", "CONFIRMED", T)).toBe(false);
    expect(canTransitionLifecycle("FAILED", "CONFIRMED", T)).toBe(false);
  });

  it("no shortcut skips RECORDED: DRAFT cannot go straight to CONFIRMED or FAILED", () => {
    expect(canTransitionLifecycle("DRAFT", "CONFIRMED", T)).toBe(false);
    expect(canTransitionLifecycle("DRAFT", "FAILED", T)).toBe(false);
  });

  it("VOID is reachable from DRAFT/RECORDED/FAILED/CONFIRMED (the reasoned correction/reversal path) and is terminal", () => {
    for (const from of ["DRAFT", "RECORDED", "FAILED", "CONFIRMED"]) expect(canTransitionLifecycle(from, "VOID", T)).toBe(true);
    for (const state of Object.keys(T)) expect(canTransitionLifecycle("VOID", state, T)).toBe(false);
  });

  it("DRAFT has no other predecessor besides FAILED", () => {
    for (const state of Object.keys(T)) {
      if (state === "FAILED") continue;
      expect(canTransitionLifecycle(state, "DRAFT", T)).toBe(false);
    }
  });
});
