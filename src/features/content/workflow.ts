// Step 11A.1: pure, framework-free logic for the Content Detail lifecycle
// workflow strip and the Next Action panel's decision table - extracted
// into their own module specifically so they can be unit-tested without
// standing up a React component test toolchain. ContentDetail.tsx and
// ContentNextActionPanel.tsx both import from here rather than
// re-implementing the same computation inline.
//
// Rewritten for the simplified post-link-review model: OPEN ->
// UNDER_REVIEW -> APPROVED is the only mainline (3 positions, not the
// retired two-policy model's 6-/4-step tables), with
// REVISION_REQUESTED/CANCELLED rendered exactly like the old
// CHANGES_REQUIRED/REJECTED/CANCELLED branch states - done-only up to
// whatever was reached, never "current".
import type { ContentStatus } from "@/server/content/types";

export type ContentTimestamps = {
  firstSubmittedAt: string | null;
  approvedAt: string | null;
};

export const CONTENT_MAINLINE_STEPS: ContentStatus[] = ["OPEN", "UNDER_REVIEW", "APPROVED"];

// Computed from TIMESTAMPS, never from raw `status` - status can be a
// branch/terminal value (REVISION_REQUESTED/CANCELLED) that isn't itself
// one of the mainline steps. Most-advanced-first precedence.
export function reachedIndex(t: ContentTimestamps): number {
  if (t.approvedAt) return 2;
  if (t.firstSubmittedAt) return 1;
  return 0;
}

export type StepState = "done" | "current" | "";

// The mainline steps' render state. When `status` is itself one of the
// mainline statuses, the reached step is "current" and forward-progress
// is implied normally. When `status` is a branch/terminal value not on
// the mainline (REVISION_REQUESTED/CANCELLED), everything up to and
// including reachedIndex renders as "done" only - nothing is "current" -
// so the strip never implies forward progress past a branch.
export function stepStates(reachedIndexValue: number, stepCount: number, status: ContentStatus, mainlineSteps: readonly ContentStatus[]): StepState[] {
  const isMainline = (mainlineSteps as readonly string[]).includes(status);
  return Array.from({ length: stepCount }, (_, i) => {
    if (isMainline) {
      if (i < reachedIndexValue) return "done";
      if (i === reachedIndexValue) return "current";
      return "";
    }
    // Branch/terminal: done-only up to reachedIndex, never current.
    return i <= reachedIndexValue ? "done" : "";
  });
}

// ---- Next Action decision table (ContentNextActionPanel) ----
//
// Step 11A.1's drastic simplification: submission only ever happens via
// the public page now, so staff never has a "start production" / "save
// version" / "submit" / "record publication" / "complete" action to take
// here anymore - only the two Manager review decisions (against
// UNDER_REVIEW) remain a real staff action.
export type NextActionKind = "awaiting_submission" | "review_submission" | "awaiting_review" | "terminal_approved" | "terminal_cancelled" | "none";

export function decideNextAction(content: { status: ContentStatus }, actorCanReview: boolean): NextActionKind {
  const { status } = content;

  if (status === "OPEN" || status === "REVISION_REQUESTED") return "awaiting_submission";
  if (status === "UNDER_REVIEW") return actorCanReview ? "review_submission" : "awaiting_review";
  if (status === "APPROVED") return "terminal_approved";
  if (status === "CANCELLED") return "terminal_cancelled";
  return "none";
}
