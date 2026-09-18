import { z } from "zod";

import { CONTENT_LIFECYCLE_TRANSITIONS, canTransitionLifecycle } from "@/server/authz/lifecycle";
import type { ActorContext } from "@/server/authz/types";
import { assignmentDocSchema, type AssignmentDoc } from "@/server/assignments/types";
import { assignmentsCollection } from "@/server/assignments/firestore";
import { writeAssignmentEvent } from "@/server/assignments/assignment-events";
import { getAdminFirestore } from "@/server/firebase/admin";
import { toContentDto, type ContentDto } from "./client-dto";
import { writeContentEvent } from "./content-events";
import { loadAuthorizedContent } from "./content-service";
import { evaluateAssignmentFulfillment } from "./fulfillment-service";
import { contentCollection } from "./firestore";
import { contentDocSchema, contentInvalidInputResult, qualifyingFulfillmentSchema, type ContentDoc, type ContentServiceResult, type QualifyingFulfillment } from "./types";

// Step 11A.1: retires submitContentForReview (staff-side pre-publication
// submit - no longer exists, submission only ever happens via the public
// page), reviewContentDecision (replaced by the two distinct functions
// below - matches section 9's "exactly two Manager decisions", never one
// generic decision wrapper), addPublicationEvidence (staff no longer
// records publication evidence directly - only the public page's own
// submit does), and completeContent (approval IS closing now, no
// separate Complete Content step anywhere).

// ---- Approve ----

const approveContentThreadInputSchema = z.object({ reviewedRevisionNumber: z.number().int().min(1), expectedVersion: z.number().int().min(1) }).strict();
export type ApproveContentThreadInput = z.input<typeof approveContentThreadInputSchema>;

type ApproveTxResult =
  | { kind: "ok"; doc: ContentDoc; assignmentCompleted: boolean; freshAssignment: AssignmentDoc | null }
  | { kind: "stale" }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "stale_decision" };

// Mirrors the retired completeContent's exact "read Assignment fresh,
// evaluate fulfillment with an override, conditionally also complete the
// Assignment in the same transaction, write one lifecycle_transitioned
// Assignment event afterward when it did" shape - simplified per the new
// one-thread evaluator (no slot-counting, no compatibility re-check,
// since there is no platform/format compatibility concept left to
// re-verify). For the one-thread-per-Assignment model, a thread reaching
// APPROVED is always the Assignment's own required obligation by
// construction, so qualifyingFulfillment is always QUALIFYING_REQUIRED.
export async function approveContentThread(actor: ActorContext | null, contentRef: unknown, rawInput: unknown, requestId: string): Promise<ContentServiceResult<ContentDto>> {
  const loaded = await loadAuthorizedContent(actor, contentRef, "review_content");
  if (!loaded.ok) return loaded.error;
  const content = loaded.content;

  const parsed = approveContentThreadInputSchema.safeParse(rawInput);
  if (!parsed.success) return contentInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (content.status !== "UNDER_REVIEW") {
    return contentInvalidInputResult(`Cannot approve Content from ${content.status}.`);
  }
  // Stale-decision pre-check: the reviewer must be deciding on the
  // revision that is actually still the latest submitted one.
  if (input.reviewedRevisionNumber !== content.reviewedRevisionNumber) {
    return { ok: false, code: "stale_write", message: "This decision targets an outdated submitted revision. Reload and try again." };
  }

  const now = new Date().toISOString();
  const qualifyingFulfillment: QualifyingFulfillment = qualifyingFulfillmentSchema.parse({ kind: "QUALIFYING_REQUIRED", reasonCode: null, determinedAt: now });

  const db = getAdminFirestore();
  const contentDocRef = contentCollection().doc(content.uid);

  const result = await db.runTransaction<ApproveTxResult>(async (tx) => {
    const contentSnap = await tx.get(contentDocRef);
    if (!contentSnap.exists) return { kind: "not_found" };
    const parsedCurrent = contentDocSchema.safeParse(contentSnap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const freshContent = parsedCurrent.data;

    if (freshContent.version !== input.expectedVersion) return { kind: "stale" };
    if (freshContent.status !== "UNDER_REVIEW") return { kind: "invalid" };
    // Re-verify the same race a second time, inside the transaction - a
    // resubmission may have landed between the pre-check above and here.
    if (input.reviewedRevisionNumber !== freshContent.reviewedRevisionNumber) return { kind: "stale_decision" };

    const assignmentSnap = await tx.get(assignmentsCollection().where("assignmentRef", "==", freshContent.assignmentRef).limit(1));
    const parsedAssignment = !assignmentSnap.empty ? assignmentDocSchema.safeParse(assignmentSnap.docs[0]!.data()) : null;
    const freshAssignment = parsedAssignment?.success ? parsedAssignment.data : null;

    const fulfillment = freshAssignment ? await evaluateAssignmentFulfillment(freshAssignment, tx, { contentUid: freshContent.uid, willBeApproved: true }) : null;

    const updatedContent: ContentDoc = {
      ...freshContent,
      status: "APPROVED",
      statusReason: null,
      approvedAt: now,
      qualifyingFulfillment,
      version: freshContent.version + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    tx.set(contentDocRef, updatedContent);

    let assignmentCompleted = false;
    if (freshAssignment && fulfillment?.fulfilled && freshAssignment.status === "IN_PROGRESS") {
      const updatedAssignment: AssignmentDoc = {
        ...freshAssignment,
        status: "COMPLETED",
        statusReason: null,
        version: freshAssignment.version + 1,
        updatedAt: now,
        updatedByUserRef: actor!.userRef,
      };
      tx.set(assignmentsCollection().doc(freshAssignment.uid), updatedAssignment);
      assignmentCompleted = true;
    }

    return { kind: "ok", doc: updatedContent, assignmentCompleted, freshAssignment: assignmentCompleted ? freshAssignment : null };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Content not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Content was changed elsewhere. Reload and try again." };
  if (result.kind === "stale_decision") return { ok: false, code: "stale_write", message: "This decision targets an outdated submitted revision. Reload and try again." };
  if (result.kind === "invalid") return contentInvalidInputResult(`Cannot approve Content from ${content.status}.`);

  await writeContentEvent({ contentUid: content.uid, kind: "approved", actorUserRef: actor!.userRef, metadata: { revisionNumber: input.reviewedRevisionNumber }, requestId });

  // The ONE place Content is allowed to write into Assignment's own event
  // history - only as a direct, explained consequence of the same
  // transaction that just approved this thread, never a separate
  // uncoordinated write. There is no separate "Complete Content" step
  // anywhere - approval IS closing.
  if (result.assignmentCompleted && result.freshAssignment) {
    await writeAssignmentEvent({
      assignmentUid: result.freshAssignment.uid,
      kind: "lifecycle_transitioned",
      actorUserRef: actor!.userRef,
      metadata: { from: "IN_PROGRESS", to: "COMPLETED", reason: null, trigger: "content_fulfillment", triggeringContentRef: content.contentRef },
      requestId,
    });
  }

  return { ok: true, data: await toContentDto(result.doc) };
}

// ---- Request revision ----

const requestContentRevisionInputSchema = z
  .object({ reason: z.string().min(1).max(1000), reviewedRevisionNumber: z.number().int().min(1), expectedVersion: z.number().int().min(1) })
  .strict();
export type RequestContentRevisionInput = z.input<typeof requestContentRevisionInputSchema>;

type RequestRevisionTxResult = { kind: "ok"; doc: ContentDoc } | { kind: "stale" } | { kind: "invalid" } | { kind: "not_found" } | { kind: "stale_decision" };

// Reopens the SAME public page/token for correction and resubmission - no
// new session/token is ever minted here. The public submit route
// (external-submission-service.ts's submitExternalLinks) is what actually
// re-locks the page on resubmit by moving the thread back to
// UNDER_REVIEW.
export async function requestContentRevision(actor: ActorContext | null, contentRef: unknown, rawInput: unknown, requestId: string): Promise<ContentServiceResult<ContentDto>> {
  const loaded = await loadAuthorizedContent(actor, contentRef, "review_content");
  if (!loaded.ok) return loaded.error;
  const content = loaded.content;

  const parsed = requestContentRevisionInputSchema.safeParse(rawInput);
  if (!parsed.success) return contentInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (content.status !== "UNDER_REVIEW") {
    return contentInvalidInputResult(`Cannot request revision on Content from ${content.status}.`);
  }
  if (input.reviewedRevisionNumber !== content.reviewedRevisionNumber) {
    return { ok: false, code: "stale_write", message: "This decision targets an outdated submitted revision. Reload and try again." };
  }

  const now = new Date().toISOString();
  const db = getAdminFirestore();
  const docRef = contentCollection().doc(content.uid);

  const result = await db.runTransaction<RequestRevisionTxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsedCurrent = contentDocSchema.safeParse(snap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const fresh = parsedCurrent.data;

    if (fresh.version !== input.expectedVersion) return { kind: "stale" };
    if (fresh.status !== "UNDER_REVIEW") return { kind: "invalid" };
    if (input.reviewedRevisionNumber !== fresh.reviewedRevisionNumber) return { kind: "stale_decision" };

    const updated: ContentDoc = {
      ...fresh,
      status: "REVISION_REQUESTED",
      statusReason: input.reason,
      version: fresh.version + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    tx.set(docRef, updated);
    return { kind: "ok", doc: updated };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Content not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Content was changed elsewhere. Reload and try again." };
  if (result.kind === "stale_decision") return { ok: false, code: "stale_write", message: "This decision targets an outdated submitted revision. Reload and try again." };
  if (result.kind === "invalid") return contentInvalidInputResult(`Cannot request revision on Content from ${content.status}.`);

  await writeContentEvent({
    contentUid: content.uid,
    kind: "revision_requested",
    actorUserRef: actor!.userRef,
    metadata: { revisionNumber: input.reviewedRevisionNumber, reason: input.reason },
    requestId,
  });

  return { ok: true, data: await toContentDto(result.doc) };
}

// ---- Cancel ----

const cancelContentInputSchema = z.object({ reason: z.string().min(1).max(1000), expectedVersion: z.number().int().min(1) }).strict();
export type CancelContentInput = z.input<typeof cancelContentInputSchema>;

type CancelTxResult = { kind: "ok"; doc: ContentDoc } | { kind: "stale" } | { kind: "invalid" } | { kind: "not_found" };

export async function cancelContent(actor: ActorContext | null, contentRef: unknown, rawInput: unknown, requestId: string): Promise<ContentServiceResult<ContentDto>> {
  const loaded = await loadAuthorizedContent(actor, contentRef, "cancel_content");
  if (!loaded.ok) return loaded.error;
  const content = loaded.content;

  const parsed = cancelContentInputSchema.safeParse(rawInput);
  if (!parsed.success) return contentInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  // CONTENT_LIFECYCLE_TRANSITIONS.CANCELLED already structurally excludes
  // APPROVED (finality - "approved = closed") - no separate check layered
  // on top; the table IS that check.
  if (!canTransitionLifecycle(content.status, "CANCELLED", CONTENT_LIFECYCLE_TRANSITIONS)) {
    return contentInvalidInputResult(`Cannot move Content from ${content.status} to CANCELLED.`);
  }

  const now = new Date().toISOString();
  const db = getAdminFirestore();
  const docRef = contentCollection().doc(content.uid);

  const result = await db.runTransaction<CancelTxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsedCurrent = contentDocSchema.safeParse(snap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const fresh = parsedCurrent.data;

    if (fresh.version !== input.expectedVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(fresh.status, "CANCELLED", CONTENT_LIFECYCLE_TRANSITIONS)) return { kind: "invalid" };

    const updated: ContentDoc = {
      ...fresh,
      status: "CANCELLED",
      statusReason: input.reason,
      cancelledAt: now,
      version: fresh.version + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    tx.set(docRef, updated);
    return { kind: "ok", doc: updated };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Content not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Content was changed elsewhere. Reload and try again." };
  if (result.kind === "invalid") return contentInvalidInputResult(`Cannot move Content from ${content.status} to CANCELLED.`);

  await writeContentEvent({ contentUid: content.uid, kind: "cancelled", actorUserRef: actor!.userRef, metadata: { reason: input.reason }, requestId });

  return { ok: true, data: await toContentDto(result.doc) };
}
