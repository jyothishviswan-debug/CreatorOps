import type { AssignmentDoc } from "@/server/assignments/types";
import { contentCollection } from "./firestore";
import { contentDocSchema, type ContentReadinessIssue } from "./types";

function blocker(code: string, message: string): ContentReadinessIssue {
  return { code, message };
}

export type AssignmentFulfillmentResult = {
  fulfilled: boolean;
  blockers: ContentReadinessIssue[];
  requiredCount: number;
  qualifyingCount: number;
};

// Finding #50 (reopened): canonical semantics restored - one Assignment
// carries the obligation (requiredCount, on its brief), and MULTIPLE
// qualifying Content records fulfill it, never links inside one thread.
// This queries every Content record for the Assignment (there can be
// several across separate submission cycles - see
// resolveOrCreateContentThread in content-service.ts) and counts how many
// have reached APPROVED. qualifyingCount is that real count - it can
// exceed requiredCount (over-fulfillment is allowed and reported
// honestly, never clamped, never an error). requiredCount defaults to 1
// when unset, which every pre-existing single-cycle Assignment already
// satisfies with its one approved thread, so default behavior is
// unchanged.
//
// Deliberately UNBOUNDED (no .limit()) - this feeds a gating decision
// (Assignment auto-completion, manual completion, CANCELLED-transition
// blocking), not a display surface. A silent truncation here would be a
// real correctness bug (undercounting real qualifying work), not a UX
// nicety - unlike evidence-collector.ts's bounded, truncation-flagged
// scans, which feed a display/evidence surface where an honest "more
// exists" flag is the right tradeoff. Real-world cardinality here is
// bounded by deliberate human submission cycles (also soft-capped by
// MAX_ASSIGNMENT_REQUIRED_COUNT, assignments/types.ts), never
// attacker-controlled volume, so an unbounded read is safe in practice.
//
// `override` lets a caller who is deciding the fate of ONE specific
// Content record IN THE SAME TRANSACTION (approveContentThread, in
// content-lifecycle-service.ts) substitute its about-to-be-written status
// for whatever is currently on disk - required because a Firestore
// transaction must complete every read before any write. That record is
// already present in the query result (the transaction only changes its
// status, never creates it), so the override just overrides its counted
// approval state in place - no separate "add" branch needed.
//
// Accepts an optional Firestore transaction so reads happen either as a
// pre-check (no tx) or as the actual gating read INSIDE the transaction
// that performs an approval/completion (tx passed) - a concurrent
// approval/cancellation of any of the Assignment's records correctly
// forces a retry rather than racing.
export async function evaluateAssignmentFulfillment(
  assignment: AssignmentDoc,
  tx?: FirebaseFirestore.Transaction,
  override?: { contentUid: string; willBeApproved: boolean },
): Promise<AssignmentFulfillmentResult> {
  const requiredCount = assignment.brief.requiredCount ?? 1;

  const contentQuery = contentCollection().where("assignmentRef", "==", assignment.assignmentRef);
  const contentSnap = tx ? await tx.get(contentQuery) : await contentQuery.get();

  let sawAny = false;
  let qualifyingCount = 0;
  for (const doc of contentSnap.docs) {
    const parsed = contentDocSchema.safeParse(doc.data());
    if (!parsed.success) continue;
    sawAny = true;
    const isApproved = override && override.contentUid === parsed.data.uid ? override.willBeApproved : parsed.data.status === "APPROVED";
    if (isApproved) qualifyingCount += 1;
  }

  if (!sawAny) {
    return {
      fulfilled: false,
      blockers: [blocker("NO_SUBMISSION_THREAD", "No submission has been made for this Assignment yet.")],
      requiredCount,
      qualifyingCount: 0,
    };
  }

  if (qualifyingCount < requiredCount) {
    return {
      fulfilled: false,
      blockers: [blocker("CONTENT_NOT_FULFILLED", `This Assignment requires ${requiredCount} approved submission(s); ${qualifyingCount} currently approved.`)],
      requiredCount,
      qualifyingCount,
    };
  }

  return { fulfilled: true, blockers: [], requiredCount, qualifyingCount };
}
