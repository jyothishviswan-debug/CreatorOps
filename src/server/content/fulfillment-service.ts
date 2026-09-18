import type { AssignmentDoc } from "@/server/assignments/types";
import { contentAssignmentThreadClaimsCollection, contentCollection } from "./firestore";
import { contentAssignmentThreadClaimDocSchema, contentDocSchema, type ContentDoc, type ContentReadinessIssue } from "./types";

function blocker(code: string, message: string): ContentReadinessIssue {
  return { code, message };
}

export type AssignmentFulfillmentResult = {
  fulfilled: boolean;
  blockers: ContentReadinessIssue[];
  requiredCount: number;
  qualifyingCount: number;
};

// Step 11A.1: resolves the Assignment's own single canonical Content
// thread via the contentAssignmentThreadClaims doc (id = assignmentRef)
// and asks one question: has it reached APPROVED? No slot-counting, no
// per-record compatibility re-check - the one-thread-per-Assignment model
// makes the old countQualifyingContentForAssignment's slot arithmetic
// unnecessary, so it has been deleted rather than kept as dead code.
//
// `override` lets a caller who is deciding the fate of ONE specific
// Content thread IN THE SAME TRANSACTION (approveContentThread, in
// content-lifecycle-service.ts) substitute its about-to-be-written status
// for whatever is currently on disk - required because a Firestore
// transaction must complete every read before any write.
//
// Accepts an optional Firestore transaction so reads happen either as a
// pre-check (no tx) or as the actual gating read INSIDE the transaction
// that performs an approval/completion (tx passed) - a concurrent
// approval/cancellation of the thread correctly forces a retry rather
// than racing.
export async function evaluateAssignmentFulfillment(
  assignment: AssignmentDoc,
  tx?: FirebaseFirestore.Transaction,
  override?: { contentUid: string; willBeApproved: boolean },
): Promise<AssignmentFulfillmentResult> {
  const claimQuery = contentAssignmentThreadClaimsCollection().doc(assignment.assignmentRef);
  const claimSnap = tx ? await tx.get(claimQuery) : await claimQuery.get();

  if (!claimSnap.exists) {
    return {
      fulfilled: false,
      blockers: [blocker("NO_SUBMISSION_THREAD", "No submission has been made for this Assignment yet.")],
      requiredCount: 1,
      qualifyingCount: 0,
    };
  }

  const claim = contentAssignmentThreadClaimDocSchema.safeParse(claimSnap.data());
  if (!claim.success) {
    return {
      fulfilled: false,
      blockers: [blocker("NO_SUBMISSION_THREAD", "No submission has been made for this Assignment yet.")],
      requiredCount: 1,
      qualifyingCount: 0,
    };
  }

  let fulfilled: boolean;
  if (override && override.contentUid === claim.data.contentUid) {
    fulfilled = override.willBeApproved;
  } else {
    const threadRef = contentCollection().doc(claim.data.contentUid);
    const threadSnap = tx ? await tx.get(threadRef) : await threadRef.get();
    const thread: ContentDoc | null = threadSnap.exists ? (() => {
      const parsed = contentDocSchema.safeParse(threadSnap.data());
      return parsed.success ? parsed.data : null;
    })() : null;
    fulfilled = thread?.status === "APPROVED";
  }

  if (fulfilled) {
    return { fulfilled: true, blockers: [], requiredCount: 1, qualifyingCount: 1 };
  }

  return {
    fulfilled: false,
    blockers: [blocker("CONTENT_NOT_FULFILLED", "This Assignment's submission thread has not been approved yet.")],
    requiredCount: 1,
    qualifyingCount: 0,
  };
}
