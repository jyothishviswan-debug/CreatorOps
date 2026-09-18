// Step 11B: this repo's existing test convention is server/logic-only -
// no React component test infrastructure (@testing-library/react, jsdom)
// is set up anywhere in the codebase (grep confirms zero *.test.tsx files
// exist). Rather than introduce a whole new test toolchain for this one
// UI step, the Content Detail workflow strip's reachedIndex algorithm and
// the Next Action decision table were extracted into workflow.ts as
// plain, framework-free functions specifically so they could be unit-
// tested directly here - the actual rendered-DOM proof (raw refs absent,
// review action visibility, etc) lives in tests/e2e/content.spec.ts
// instead.
import { describe, expect, it } from "vitest";

import {
  decideNextAction,
  NO_PREPOST_REVIEW_STEPS,
  reachedIndexNoPrepostReview,
  reachedIndexReviewRequired,
  REVIEW_REQUIRED_STEPS,
  stepStates,
} from "./workflow";

const NO_TIMESTAMPS = { productionStartedAt: null, submittedAt: null, approvedAt: null, postedAt: null, completedAt: null };

describe("reachedIndexReviewRequired", () => {
  it("returns 0 (Planned) when nothing is set", () => {
    expect(reachedIndexReviewRequired(NO_TIMESTAMPS)).toBe(0);
  });

  it("follows most-advanced-first precedence, not first-set-wins", () => {
    expect(reachedIndexReviewRequired({ ...NO_TIMESTAMPS, productionStartedAt: "t" })).toBe(1);
    expect(reachedIndexReviewRequired({ ...NO_TIMESTAMPS, productionStartedAt: "t", submittedAt: "t" })).toBe(2);
    expect(reachedIndexReviewRequired({ ...NO_TIMESTAMPS, productionStartedAt: "t", submittedAt: "t", approvedAt: "t" })).toBe(3);
    expect(reachedIndexReviewRequired({ ...NO_TIMESTAMPS, productionStartedAt: "t", submittedAt: "t", approvedAt: "t", postedAt: "t" })).toBe(4);
    expect(reachedIndexReviewRequired({ ...NO_TIMESTAMPS, productionStartedAt: "t", submittedAt: "t", approvedAt: "t", postedAt: "t", completedAt: "t" })).toBe(5);
  });

  it("CHANGES_REQUIRED's own timestamp shape (submittedAt set, approvedAt not) lands on index 2 (Submitted)", () => {
    expect(reachedIndexReviewRequired({ ...NO_TIMESTAMPS, productionStartedAt: "t", submittedAt: "t" })).toBe(2);
  });
});

describe("reachedIndexNoPrepostReview", () => {
  it("returns 0 (Planned) when nothing is set", () => {
    expect(reachedIndexNoPrepostReview(NO_TIMESTAMPS)).toBe(0);
  });

  it("follows most-advanced-first precedence over the 4-position mainline", () => {
    expect(reachedIndexNoPrepostReview({ ...NO_TIMESTAMPS, productionStartedAt: "t" })).toBe(1);
    expect(reachedIndexNoPrepostReview({ ...NO_TIMESTAMPS, productionStartedAt: "t", postedAt: "t" })).toBe(2);
    expect(reachedIndexNoPrepostReview({ ...NO_TIMESTAMPS, productionStartedAt: "t", postedAt: "t", completedAt: "t" })).toBe(3);
  });
});

describe("stepStates", () => {
  it("mainline status: steps before reachedIndex are done, reachedIndex is current, later steps are plain", () => {
    const states = stepStates(2, REVIEW_REQUIRED_STEPS.length, "SUBMITTED", REVIEW_REQUIRED_STEPS);
    expect(states).toEqual(["done", "done", "current", "", "", ""]);
  });

  it("CHANGES_REQUIRED (branch, not mainline): done-only up to reachedIndex, never current - no implied forward progress", () => {
    const states = stepStates(2, REVIEW_REQUIRED_STEPS.length, "CHANGES_REQUIRED", REVIEW_REQUIRED_STEPS);
    expect(states).toEqual(["done", "done", "done", "", "", ""]);
    expect(states).not.toContain("current");
  });

  it("REJECTED (terminal, not mainline): done-only up to reachedIndex, never current", () => {
    const states = stepStates(2, REVIEW_REQUIRED_STEPS.length, "REJECTED", REVIEW_REQUIRED_STEPS);
    expect(states).toEqual(["done", "done", "done", "", "", ""]);
  });

  it("CANCELLED after production started but before submission: done-only through index 1", () => {
    const states = stepStates(1, REVIEW_REQUIRED_STEPS.length, "CANCELLED", REVIEW_REQUIRED_STEPS);
    expect(states).toEqual(["done", "done", "", "", "", ""]);
  });

  it("NO_PREPOST_REVIEW mainline: 4-position strip, current at reachedIndex", () => {
    const states = stepStates(2, NO_PREPOST_REVIEW_STEPS.length, "POSTED", NO_PREPOST_REVIEW_STEPS);
    expect(states).toEqual(["done", "done", "current", ""]);
  });
});

describe("decideNextAction", () => {
  const base = { reviewPolicy: "REVIEW_REQUIRED" as const, currentVersion: 0, lastSubmittedVersion: null as number | null };

  it("PLANNED -> start_production", () => {
    expect(decideNextAction({ ...base, status: "PLANNED" }, false)).toBe("start_production");
  });

  it("IN_PRODUCTION + REVIEW_REQUIRED + no version -> save_production_version", () => {
    expect(decideNextAction({ ...base, status: "IN_PRODUCTION", currentVersion: 0 }, false)).toBe("save_production_version");
  });

  it("IN_PRODUCTION + REVIEW_REQUIRED + a saved version -> submit_for_review", () => {
    expect(decideNextAction({ ...base, status: "IN_PRODUCTION", currentVersion: 1 }, false)).toBe("submit_for_review");
  });

  it("IN_PRODUCTION + NO_PREPOST_REVIEW -> record_publication (no review controls at all)", () => {
    expect(decideNextAction({ ...base, status: "IN_PRODUCTION", reviewPolicy: "NO_PREPOST_REVIEW" }, false)).toBe("record_publication");
    expect(decideNextAction({ ...base, status: "IN_PRODUCTION", reviewPolicy: "NO_PREPOST_REVIEW" }, true)).toBe("record_publication");
  });

  it("SUBMITTED: review_submission only when actorCanReview, else awaiting_review", () => {
    expect(decideNextAction({ ...base, status: "SUBMITTED" }, true)).toBe("review_submission");
    expect(decideNextAction({ ...base, status: "SUBMITTED" }, false)).toBe("awaiting_review");
  });

  it("CHANGES_REQUIRED: save_revised_version until a newer version exists, then resubmit_for_review", () => {
    expect(decideNextAction({ ...base, status: "CHANGES_REQUIRED", currentVersion: 1, lastSubmittedVersion: 1 }, false)).toBe("save_revised_version");
    expect(decideNextAction({ ...base, status: "CHANGES_REQUIRED", currentVersion: 2, lastSubmittedVersion: 1 }, false)).toBe("resubmit_for_review");
  });

  it("APPROVED -> record_publication, POSTED -> complete_content", () => {
    expect(decideNextAction({ ...base, status: "APPROVED" }, false)).toBe("record_publication");
    expect(decideNextAction({ ...base, status: "POSTED" }, false)).toBe("complete_content");
  });

  it("terminal statuses have no action", () => {
    expect(decideNextAction({ ...base, status: "COMPLETED" }, false)).toBe("terminal_completed");
    expect(decideNextAction({ ...base, status: "REJECTED" }, false)).toBe("terminal_rejected");
    expect(decideNextAction({ ...base, status: "CANCELLED" }, false)).toBe("terminal_cancelled");
  });
});
