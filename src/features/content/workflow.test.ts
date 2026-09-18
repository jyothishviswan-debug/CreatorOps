// Step 11A.1: this repo's existing test convention is server/logic-only -
// no React component test infrastructure (@testing-library/react, jsdom)
// is set up anywhere in the codebase. The Content Detail workflow strip's
// reachedIndex algorithm and the Next Action decision table are plain,
// framework-free functions in workflow.ts specifically so they can be
// unit-tested directly here - the actual rendered-DOM proof lives in
// tests/e2e/content.spec.ts instead.
//
// Rewritten for the simplified post-link-review model - retires the old
// 6-step REVIEW_REQUIRED / 4-step NO_PREPOST_REVIEW tables entirely in
// favor of the single 3-position OPEN -> UNDER_REVIEW -> APPROVED
// mainline.
import { describe, expect, it } from "vitest";

import { CONTENT_MAINLINE_STEPS, decideNextAction, reachedIndex, stepStates } from "./workflow";

const NO_TIMESTAMPS = { firstSubmittedAt: null, approvedAt: null };

describe("reachedIndex", () => {
  it("returns 0 (Open) when nothing is set", () => {
    expect(reachedIndex(NO_TIMESTAMPS)).toBe(0);
  });

  it("follows most-advanced-first precedence, not first-set-wins", () => {
    expect(reachedIndex({ ...NO_TIMESTAMPS, firstSubmittedAt: "t" })).toBe(1);
    expect(reachedIndex({ ...NO_TIMESTAMPS, firstSubmittedAt: "t", approvedAt: "t" })).toBe(2);
  });

  it("REVISION_REQUESTED's own timestamp shape (firstSubmittedAt set, approvedAt not) lands on index 1 (Under review)", () => {
    expect(reachedIndex({ ...NO_TIMESTAMPS, firstSubmittedAt: "t" })).toBe(1);
  });
});

describe("stepStates", () => {
  it("mainline status: steps before reachedIndex are done, reachedIndex is current, later steps are plain", () => {
    const states = stepStates(1, CONTENT_MAINLINE_STEPS.length, "UNDER_REVIEW", CONTENT_MAINLINE_STEPS);
    expect(states).toEqual(["done", "current", ""]);
  });

  it("REVISION_REQUESTED (branch, not mainline): done-only up to reachedIndex, never current - no implied forward progress", () => {
    const states = stepStates(1, CONTENT_MAINLINE_STEPS.length, "REVISION_REQUESTED", CONTENT_MAINLINE_STEPS);
    expect(states).toEqual(["done", "done", ""]);
    expect(states).not.toContain("current");
  });

  it("CANCELLED before any submission: done-only through index 0", () => {
    const states = stepStates(0, CONTENT_MAINLINE_STEPS.length, "CANCELLED", CONTENT_MAINLINE_STEPS);
    expect(states).toEqual(["done", "", ""]);
  });

  it("CANCELLED after a submission was made: done-only through index 1", () => {
    const states = stepStates(1, CONTENT_MAINLINE_STEPS.length, "CANCELLED", CONTENT_MAINLINE_STEPS);
    expect(states).toEqual(["done", "done", ""]);
  });

  it("APPROVED mainline: current at reachedIndex 2", () => {
    const states = stepStates(2, CONTENT_MAINLINE_STEPS.length, "APPROVED", CONTENT_MAINLINE_STEPS);
    expect(states).toEqual(["done", "done", "current"]);
  });
});

describe("decideNextAction", () => {
  it("OPEN and REVISION_REQUESTED -> awaiting_submission (no staff action - submission only happens via the public page)", () => {
    expect(decideNextAction({ status: "OPEN" }, false)).toBe("awaiting_submission");
    expect(decideNextAction({ status: "OPEN" }, true)).toBe("awaiting_submission");
    expect(decideNextAction({ status: "REVISION_REQUESTED" }, true)).toBe("awaiting_submission");
  });

  it("UNDER_REVIEW: review_submission only when actorCanReview, else awaiting_review", () => {
    expect(decideNextAction({ status: "UNDER_REVIEW" }, true)).toBe("review_submission");
    expect(decideNextAction({ status: "UNDER_REVIEW" }, false)).toBe("awaiting_review");
  });

  it("terminal statuses have no staff action", () => {
    expect(decideNextAction({ status: "APPROVED" }, false)).toBe("terminal_approved");
    expect(decideNextAction({ status: "CANCELLED" }, false)).toBe("terminal_cancelled");
  });
});
