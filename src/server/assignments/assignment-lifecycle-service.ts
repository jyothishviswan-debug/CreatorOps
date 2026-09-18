import { z } from "zod";

import { ASSIGNMENT_LIFECYCLE_TRANSITIONS, canTransitionLifecycle } from "@/server/authz/lifecycle";
import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import { contentCollection } from "@/server/content/firestore";
import { evaluateAssignmentFulfillment } from "@/server/content/fulfillment-service";
import { requireAssignmentInScope, requireAssignmentsAccess } from "./assignments-gate";
import { writeAssignmentEvent } from "./assignment-events";
import { assignmentExternalSubmissionsCollection, assignmentsCollection, getAssignmentDocByRef } from "./firestore";
import {
  ASSIGNMENT_REASON_REQUIRED_STATUSES,
  assignmentDocSchema,
  assignmentStatusSchema,
  assignmentsInvalidInputResult,
  assignmentsUnauthorizedResult,
  type AssignmentDoc,
  type AssignmentStatus,
  type AssignmentsServiceResult,
} from "./types";

const transitionInputSchema = z.object({
  to: assignmentStatusSchema,
  reason: z.string().min(1).max(1000).optional(),
  expectedVersion: z.number().int().min(1),
});
export type TransitionAssignmentInput = z.input<typeof transitionInputSchema>;

type TxResult =
  | { kind: "ok"; doc: AssignmentDoc }
  | { kind: "stale" }
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: "blocked_by_evidence" }
  | { kind: "blocked_by_content_evidence" }
  | { kind: "blocked_by_unfulfilled_content"; blockers: { code: string; message: string }[] };

// The one trusted entry point for every Assignment lifecycle change,
// mirroring Campaigns' own transitionCampaignLifecycle. Moving to
// CANCELLED needs the separate, reasoned `cancel_assignment` action;
// every other edge shares the ordinary `transition_assignment_lifecycle`
// action - same "one generic ordinary-transition action plus a separate
// reasoned/consequential one" shape as Campaign's own cancel_campaign
// split.
//
// Step 10A.1 section 2: CANCELLED is reversible-edge-shaped in the graph
// above, but is NOT unconditionally available - the immutable external-
// submission batch Step 10A introduced IS irreversible evidence, even
// before Content exists. Every CANCELLED attempt re-checks, inside the
// SAME transaction as the write (a query read before any write, so a
// concurrent submission mid-transaction correctly aborts/retries this
// one - Firestore's normal transaction snapshot-conflict behavior),
// whether any assignmentExternalSubmissions doc already references this
// Assignment; if one does, cancellation is refused with a typed
// not_ready result, never silently allowed. Once Content exists, its own
// irreversible-evidence check belongs in this same place, checked the
// same way.
//
// Step 11A: IN_PROGRESS -> COMPLETED now uses the real, shared
// fulfillment evaluator (evaluateAssignmentFulfillment /
// countQualifyingContentForAssignment in
// @/server/content/fulfillment-service) instead of the earlier
// always-fails-closed stub - Content now exists to prove the obligation
// was actually fulfilled. A pre-check runs before the transaction (fast,
// non-transactional, most callers hit this) and the SAME evaluator runs
// again INSIDE the transaction (transactional, race-safe - a concurrent
// Content completion/cancellation forces a retry rather than racing,
// same discipline as the CANCELLED evidence-blocker check below). This
// is the one shared evaluator behind both the manual completion request
// here and Content's own auto-completion trigger (completeContent in
// content-lifecycle-service.ts, which calls
// countQualifyingContentForAssignment directly with an in-flight
// override rather than through this wrapper - see that function's own
// comment for why).
export async function transitionAssignmentLifecycle(
  actor: ActorContext | null,
  assignmentRef: unknown,
  rawInput: unknown,
  requestId: string,
): Promise<AssignmentsServiceResult<{ version: number; status: AssignmentStatus }>> {
  if (!actor) return assignmentsUnauthorizedResult("not_authenticated");

  const parsed = transitionInputSchema.safeParse(rawInput);
  if (!parsed.success) return assignmentsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const requiredAction = input.to === "CANCELLED" ? "cancel_assignment" : "transition_assignment_lifecycle";
  const gate = await requireAssignmentsAccess(actor, requiredAction);
  if (!gate.ok) return assignmentsUnauthorizedResult(gate.reason);

  if (typeof assignmentRef !== "string" || assignmentRef.length === 0) return assignmentsInvalidInputResult("Missing assignmentRef.");

  if ((ASSIGNMENT_REASON_REQUIRED_STATUSES as readonly AssignmentStatus[]).includes(input.to) && !input.reason) {
    return assignmentsInvalidInputResult(`A reason is required to move an Assignment to ${input.to}.`);
  }

  const current = await getAssignmentDocByRef(assignmentRef);
  if (!current) return { ok: false, code: "not_found", message: "Assignment not found." };

  const scopeCheck = await requireAssignmentInScope(actor, current);
  if (!scopeCheck.ok) return assignmentsUnauthorizedResult(scopeCheck.reason);

  if (!canTransitionLifecycle(current.status, input.to, ASSIGNMENT_LIFECYCLE_TRANSITIONS)) {
    return assignmentsInvalidInputResult(`Cannot move an Assignment from ${current.status} to ${input.to}.`);
  }

  if (input.to === "COMPLETED") {
    const fulfillment = await evaluateAssignmentFulfillment(current);
    if (!fulfillment.fulfilled) {
      return { ok: false, code: "not_ready", message: "This Assignment cannot be marked Completed yet.", blockers: fulfillment.blockers };
    }
  }

  const db = getAdminFirestore();
  const docRef = assignmentsCollection().doc(current.uid);

  const result = await db.runTransaction<TxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsedCurrent = assignmentDocSchema.safeParse(snap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const freshCurrent = parsedCurrent.data;

    if (freshCurrent.version !== input.expectedVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(freshCurrent.status, input.to, ASSIGNMENT_LIFECYCLE_TRANSITIONS)) return { kind: "invalid" };

    if (input.to === "CANCELLED") {
      const evidenceSnap = await tx.get(assignmentExternalSubmissionsCollection().where("assignmentRef", "==", freshCurrent.assignmentRef).limit(1));
      if (!evidenceSnap.empty) return { kind: "blocked_by_evidence" };

      // Step 11A.1: a second, Content-specific blocker query - mirrors the
      // external-submission-evidence check immediately above, just
      // against the Assignment's own canonical Content thread instead of
      // intake-only external submission rows. UNDER_REVIEW/
      // REVISION_REQUESTED/APPROVED all imply at least one revision has
      // already been submitted (currentRevisionNumber > 0) - irreversible
      // evidence. Only a still-untouched OPEN thread (or no thread at
      // all) leaves cancellation unblocked; a CANCELLED thread never
      // blocks (it is itself already a closed dead end, not live
      // evidence). Uses a single equality-friendly "in" filter (never a
      // compound inequality on two different fields, which Firestore
      // does not support without extra indexing) - same discipline as
      // the external-submission-evidence query above.
      const contentEvidenceSnap = await tx.get(
        contentCollection().where("assignmentRef", "==", freshCurrent.assignmentRef).where("status", "in", ["UNDER_REVIEW", "REVISION_REQUESTED", "APPROVED"]).limit(1),
      );
      if (!contentEvidenceSnap.empty) return { kind: "blocked_by_content_evidence" };
    }

    if (input.to === "COMPLETED") {
      // Re-run the same evaluator for real, race-safe gating inside the
      // transaction - a concurrent Content completion/cancellation
      // between the pre-check above and here forces this transaction to
      // observe fresh state (or, under Firestore's own optimistic-
      // transaction retry, to retry against it).
      const freshFulfillment = await evaluateAssignmentFulfillment(freshCurrent, tx);
      if (!freshFulfillment.fulfilled) return { kind: "blocked_by_unfulfilled_content", blockers: freshFulfillment.blockers };
    }

    const updated: AssignmentDoc = {
      ...freshCurrent,
      status: input.to,
      statusReason: (ASSIGNMENT_REASON_REQUIRED_STATUSES as readonly AssignmentStatus[]).includes(input.to) ? (input.reason ?? null) : null,
      version: freshCurrent.version + 1,
      updatedAt: new Date().toISOString(),
      updatedByUserRef: actor.userRef,
    };
    tx.set(docRef, updated);
    return { kind: "ok", doc: updated };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Assignment not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Assignment was changed elsewhere. Reload and try again." };
  if (result.kind === "invalid") return assignmentsInvalidInputResult(`Cannot move an Assignment from ${current.status} to ${input.to}.`);
  if (result.kind === "blocked_by_evidence") {
    return {
      ok: false,
      code: "not_ready",
      message: "This Assignment cannot be cancelled - it already has submitted external evidence, which is irreversible.",
      blockers: [{ code: "EXTERNAL_EVIDENCE_EXISTS", message: "At least one external submission batch already exists for this Assignment." }],
    };
  }
  if (result.kind === "blocked_by_content_evidence") {
    return {
      ok: false,
      code: "not_ready",
      message: "This Assignment cannot be cancelled - at least one of its Content records already has canonical publication evidence, which is irreversible.",
      blockers: [{ code: "CONTENT_EVIDENCE_EXISTS", message: "At least one Content record for this Assignment already has canonical publication evidence." }],
    };
  }
  if (result.kind === "blocked_by_unfulfilled_content") {
    return { ok: false, code: "not_ready", message: "This Assignment cannot be marked Completed yet.", blockers: result.blockers };
  }

  const eventKind = input.to === "CANCELLED" ? "cancelled" : "lifecycle_transitioned";
  await writeAssignmentEvent({ assignmentUid: current.uid, kind: eventKind, actorUserRef: actor.userRef, metadata: { from: current.status, to: input.to, reason: input.reason ?? null }, requestId });

  return { ok: true, data: { version: result.doc.version, status: result.doc.status } };
}
