import { describe, expect, it } from "vitest";

import { canTransitionLifecycle, CONTENT_LIFECYCLE_TRANSITIONS } from "./lifecycle";

describe("canTransitionLifecycle", () => {
  it("allows a transition from a listed predecessor state", () => {
    expect(canTransitionLifecycle("Submitted", "Approved", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(true);
  });

  it("denies a transition that skips a required intermediate state", () => {
    expect(canTransitionLifecycle("Planned", "Posted", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(false);
  });

  it("denies a transition into an unrecognized state", () => {
    expect(canTransitionLifecycle("Submitted", "Archived", CONTENT_LIFECYCLE_TRANSITIONS)).toBe(false);
  });
});
