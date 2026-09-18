// Step 11B: pure, framework-free logic for the Content Detail lifecycle
// workflow strip and the Next Action panel's decision table - extracted
// into their own module specifically so they can be unit-tested without
// standing up a React component test toolchain (this repo has none set
// up yet - see workflow.test.ts's own comment). ContentDetail.tsx and
// ContentNextActionPanel.tsx both import from here rather than
// re-implementing the same computation inline.
import type { ContentStatus } from "@/server/content/types";

export type ContentTimestamps = {
  productionStartedAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  completedAt: string | null;
};

export const REVIEW_REQUIRED_STEPS: ContentStatus[] = ["PLANNED", "IN_PRODUCTION", "SUBMITTED", "APPROVED", "POSTED", "COMPLETED"];
export const NO_PREPOST_REVIEW_STEPS: ContentStatus[] = ["PLANNED", "IN_PRODUCTION", "POSTED", "COMPLETED"];

// Computed from TIMESTAMPS, never from raw `status` - status can be a
// branch/terminal value (CHANGES_REQUIRED/REJECTED/CANCELLED) that isn't
// itself one of the mainline steps. Most-advanced-first precedence.
export function reachedIndexReviewRequired(t: ContentTimestamps): number {
  if (t.completedAt) return 5;
  if (t.postedAt) return 4;
  if (t.approvedAt) return 3;
  if (t.submittedAt) return 2;
  if (t.productionStartedAt) return 1;
  return 0;
}

export function reachedIndexNoPrepostReview(t: ContentTimestamps): number {
  if (t.completedAt) return 3;
  if (t.postedAt) return 2;
  if (t.productionStartedAt) return 1;
  return 0;
}

export type StepState = "done" | "current" | "";

// The mainline steps' render state. When `status` is itself one of the
// mainline statuses, the reached step is "current" and forward-progress
// is implied normally. When `status` is a branch/terminal value not on
// the mainline (CHANGES_REQUIRED/REJECTED/CANCELLED), everything up to
// and including reachedIndex renders as "done" only - nothing is
// "current" - so the strip never implies forward progress past a branch.
export function stepStates(reachedIndex: number, stepCount: number, status: ContentStatus, mainlineSteps: readonly ContentStatus[]): StepState[] {
  const isMainline = (mainlineSteps as readonly string[]).includes(status);
  return Array.from({ length: stepCount }, (_, i) => {
    if (isMainline) {
      if (i < reachedIndex) return "done";
      if (i === reachedIndex) return "current";
      return "";
    }
    // Branch/terminal: done-only up to reachedIndex, never current.
    return i <= reachedIndex ? "done" : "";
  });
}

// ---- Next Action decision table (ContentNextActionPanel) ----

export type NextActionKind =
  | "start_production"
  | "save_production_version"
  | "submit_for_review"
  | "record_publication"
  | "review_submission"
  | "awaiting_review"
  | "save_revised_version"
  | "resubmit_for_review"
  | "complete_content"
  | "terminal_completed"
  | "terminal_rejected"
  | "terminal_cancelled"
  | "none";

export function decideNextAction(
  content: {
    status: ContentStatus;
    reviewPolicy: "REVIEW_REQUIRED" | "NO_PREPOST_REVIEW";
    currentVersion: number;
    lastSubmittedVersion: number | null;
  },
  actorCanReview: boolean,
): NextActionKind {
  const { status, reviewPolicy, currentVersion, lastSubmittedVersion } = content;

  if (status === "PLANNED") return "start_production";

  if (status === "IN_PRODUCTION") {
    if (reviewPolicy === "REVIEW_REQUIRED") {
      return currentVersion === 0 ? "save_production_version" : "submit_for_review";
    }
    return "record_publication";
  }

  if (status === "SUBMITTED") {
    if (reviewPolicy !== "REVIEW_REQUIRED") return "none";
    return actorCanReview ? "review_submission" : "awaiting_review";
  }

  if (status === "CHANGES_REQUIRED") {
    return currentVersion > (lastSubmittedVersion ?? 0) ? "resubmit_for_review" : "save_revised_version";
  }

  if (status === "APPROVED") return "record_publication";
  if (status === "POSTED") return "complete_content";
  if (status === "COMPLETED") return "terminal_completed";
  if (status === "REJECTED") return "terminal_rejected";
  if (status === "CANCELLED") return "terminal_cancelled";
  return "none";
}
