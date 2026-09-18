import type { AssignmentDoc } from "@/server/assignments/types";
import { contentCollection, contentRequiredSlotClaimsCollection } from "./firestore";
import { contentDocSchema, contentRequiredSlotClaimDocSchema, type ContentReadinessIssue } from "./types";

function blocker(code: string, message: string): ContentReadinessIssue {
  return { code, message };
}

// The shared core: counts real, distinct, QUALIFYING_REQUIRED Content
// records (COMPLETED + qualifyingFulfillment.kind === "QUALIFYING_REQUIRED")
// claiming a live required slot for one Assignment - never publication-URL
// count, external-submission-row count, Analytics-row count, or raw
// Content-record count (Step 11A's own explicit rule). An extra/non-
// obligation Content item (requiredSlotIndex null, never claims a slot)
// can never contribute here by construction.
//
// `override` lets a caller who is COMPLETING one specific Content record
// IN THE SAME TRANSACTION substitute its about-to-be-written qualifying
// state for whatever is currently on disk - required because a Firestore
// transaction must complete every read before any write, so the
// completing service cannot write Content=COMPLETED and then read it
// back to recompute fulfillment inside that same transaction.
//
// Accepts an optional Firestore transaction so reads happen either as a
// pre-check (no tx) or as the actual gating read INSIDE the transaction
// that performs a completion (tx passed) - the same "read the blocker
// query before any write, inside the transaction" discipline Assignment's
// own CANCELLED evidence-blocker check already uses, so a concurrent
// Content completion/cancellation correctly forces a retry rather than
// racing.
export async function countQualifyingContentForAssignment(
  assignmentRef: string,
  tx: FirebaseFirestore.Transaction | undefined,
  override?: { contentUid: string; willQualify: boolean },
): Promise<number> {
  const claimsQuery = contentRequiredSlotClaimsCollection().where("assignmentRef", "==", assignmentRef).where("state", "==", "CLAIMED");
  const claimsSnap = tx ? await tx.get(claimsQuery) : await claimsQuery.get();

  let count = 0;
  for (const claimDoc of claimsSnap.docs) {
    const claim = contentRequiredSlotClaimDocSchema.safeParse(claimDoc.data());
    if (!claim.success) continue;

    if (override && claim.data.contentUid === override.contentUid) {
      if (override.willQualify) count += 1;
      continue;
    }

    const contentRef = contentCollection().doc(claim.data.contentUid);
    const contentSnap = tx ? await tx.get(contentRef) : await contentRef.get();
    if (!contentSnap.exists) continue;
    const content = contentDocSchema.safeParse(contentSnap.data());
    if (!content.success) continue;

    if (content.data.status === "COMPLETED" && content.data.qualifyingFulfillment?.kind === "QUALIFYING_REQUIRED") count += 1;
  }

  return count;
}

export type AssignmentFulfillmentResult = {
  fulfilled: boolean;
  blockers: ContentReadinessIssue[];
  requiredCount: number;
  qualifyingCount: number;
};

// The one shared fulfillment evaluator for BOTH the manual Assignment
// completion request (assignment-lifecycle-service.ts's own COMPLETED
// transition) and the optional parent auto-completion trigger fired by
// Content's own completion (content-lifecycle-service.ts's
// completeContent, which calls countQualifyingContentForAssignment
// directly with an override rather than through this wrapper - see that
// function's own comment for why).
export async function evaluateAssignmentFulfillment(assignment: AssignmentDoc, tx?: FirebaseFirestore.Transaction): Promise<AssignmentFulfillmentResult> {
  const requiredCount = assignment.brief.requiredCount ?? 1;
  const qualifyingCount = await countQualifyingContentForAssignment(assignment.assignmentRef, tx);

  if (qualifyingCount >= requiredCount) {
    return { fulfilled: true, blockers: [], requiredCount, qualifyingCount };
  }

  return {
    fulfilled: false,
    blockers: [blocker("CONTENT_NOT_FULFILLED", `${qualifyingCount} of ${requiredCount} required Content item(s) are qualifying and completed.`)],
    requiredCount,
    qualifyingCount,
  };
}
