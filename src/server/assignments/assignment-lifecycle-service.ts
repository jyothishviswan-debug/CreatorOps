import { z } from "zod";

import { ASSIGNMENT_LIFECYCLE_TRANSITIONS, canTransitionLifecycle } from "@/server/authz/lifecycle";
import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import { requireAssignmentInScope, requireAssignmentsAccess } from "./assignments-gate";
import { writeAssignmentEvent } from "./assignment-events";
import { assignmentsCollection, getAssignmentDocByRef } from "./firestore";
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

type TxResult = { kind: "ok"; doc: AssignmentDoc } | { kind: "stale" } | { kind: "not_found" } | { kind: "invalid" };

// The one trusted entry point for every Assignment lifecycle change,
// mirroring Campaigns' own transitionCampaignLifecycle. Moving to
// CANCELLED needs the separate, reasoned `cancel_assignment` action;
// every other edge shares the ordinary `transition_assignment_lifecycle`
// action - same "one generic ordinary-transition action plus a separate
// reasoned/consequential one" shape as Campaign's own cancel_campaign
// split.
//
// IN_PROGRESS -> CANCELLED is unconditionally allowed for now (Step 10A
// section 5: "only while cancellation remains reversible" - nothing
// irreversible can have happened yet, since Content doesn't exist). THIS
// is the extension point the authority doc asks for: once Content exists,
// an "irreversible Content/publication evidence exists" check belongs
// right here, before the transaction below, without changing this
// function's own contract.
//
// IN_PROGRESS -> COMPLETED always fails closed for the same reason
// (Content doesn't exist yet to prove the obligation was actually
// fulfilled) - Step 10A section 5's own rule against inventing a manual
// "everything done" bypass. The edge stays in ASSIGNMENT_LIFECYCLE_TRANSITIONS
// (matching the authority doc's own compact model) but is refused here
// with a typed not_ready result, the same "the edge exists, but a real
// readiness check currently always blocks it" shape Campaign's own
// DRAFT -> PLANNED readiness gate uses.
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
    return {
      ok: false,
      code: "not_ready",
      message: "This Assignment cannot be marked Completed yet.",
      blockers: [{ code: "CONTENT_EVIDENCE_UNAVAILABLE", message: "Content does not exist yet - completion requires real Content evidence, which this build cannot produce." }],
    };
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

  const eventKind = input.to === "CANCELLED" ? "cancelled" : "lifecycle_transitioned";
  await writeAssignmentEvent({ assignmentUid: current.uid, kind: eventKind, actorUserRef: actor.userRef, metadata: { from: current.status, to: input.to, reason: input.reason ?? null }, requestId });

  return { ok: true, data: { version: result.doc.version, status: result.doc.status } };
}
