import { z } from "zod";

import { CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS, canTransitionLifecycle } from "@/server/authz/lifecycle";
import type { ActorContext } from "@/server/authz/types";
import { assignmentDocSchema, type AssignmentDoc } from "@/server/assignments/types";
import { assignmentsCollection, getAssignmentDocByRef } from "@/server/assignments/firestore";
import { writeAssignmentEvent } from "@/server/assignments/assignment-events";
import { httpsUrlSchema } from "@/server/assignments/external-submission-types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { platformIdentifierSchema } from "@/server/shared/platform";
import { toContentDto, type ContentDto } from "./client-dto";
import { writeContentEvent } from "./content-events";
import { checkContentCompatibleWithAssignment, checkPartnerAccountCompatibility, lifecycleTableFor, loadAuthorizedContent } from "./content-service";
import { countQualifyingContentForAssignment } from "./fulfillment-service";
import { contentCollection, contentPublicationClaimId, contentPublicationClaimsCollection, contentRequiredSlotClaimDocId, contentRequiredSlotClaimsCollection } from "./firestore";
import { generatePublicationEvidenceId } from "./ids";
import { normalizeContentUrl, publicationContentIdIdentityKey, publicationUrlIdentityKey } from "./publication-identity";
import {
  CONTENT_REASON_REQUIRED_STATUSES,
  MAX_PUBLICATION_EVIDENCE_ITEMS,
  contentDocSchema,
  contentConflictResult,
  contentInvalidInputResult,
  contentNotReadyResult,
  contentPublicationClaimDocSchema,
  contentRequiredSlotClaimDocSchema,
  publicationEvidenceItemSchema,
  qualifyingFulfillmentSchema,
  type ContentDoc,
  type ContentServiceResult,
  type ContentStatus,
  type PublicationEvidenceItem,
  type QualifyingFulfillment,
} from "./types";

// ---- Submit for review ----

const submitContentForReviewInputSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();
export type SubmitContentForReviewInput = z.input<typeof submitContentForReviewInputSchema>;

type SubmitTxResult = { kind: "ok"; doc: ContentDoc } | { kind: "stale" } | { kind: "invalid" } | { kind: "not_found" };

export async function submitContentForReview(actor: ActorContext | null, contentRef: unknown, rawInput: unknown, requestId: string): Promise<ContentServiceResult<ContentDto>> {
  const loaded = await loadAuthorizedContent(actor, contentRef, "submit_content_for_review");
  if (!loaded.ok) return loaded.error;
  const content = loaded.content;

  // Fail-safe: NO_PREPOST_REVIEW must never reach SUBMITTED.
  if (content.reviewPolicy !== "REVIEW_REQUIRED") {
    return contentInvalidInputResult("This Content does not use pre-post review.");
  }

  const parsed = submitContentForReviewInputSchema.safeParse(rawInput);
  if (!parsed.success) return contentInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (content.currentVersion < 1) {
    return contentInvalidInputResult("At least one version must be saved before submitting for review.");
  }

  if (!canTransitionLifecycle(content.status, "SUBMITTED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)) {
    return contentInvalidInputResult(`Cannot move Content from ${content.status} to SUBMITTED.`);
  }

  const now = new Date().toISOString();
  const db = getAdminFirestore();
  const docRef = contentCollection().doc(content.uid);

  const result = await db.runTransaction<SubmitTxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsedCurrent = contentDocSchema.safeParse(snap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const fresh = parsedCurrent.data;

    if (fresh.version !== input.expectedVersion) return { kind: "stale" };
    if (fresh.reviewPolicy !== "REVIEW_REQUIRED") return { kind: "invalid" };
    if (fresh.currentVersion < 1) return { kind: "invalid" };
    if (!canTransitionLifecycle(fresh.status, "SUBMITTED", CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)) return { kind: "invalid" };

    const updated: ContentDoc = {
      ...fresh,
      status: "SUBMITTED",
      lastSubmittedVersion: fresh.currentVersion,
      submittedAt: fresh.submittedAt ?? now,
      version: fresh.version + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    tx.set(docRef, updated);
    return { kind: "ok", doc: updated };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Content not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Content was changed elsewhere. Reload and try again." };
  if (result.kind === "invalid") return contentInvalidInputResult(`Cannot move Content from ${content.status} to SUBMITTED.`);

  await writeContentEvent({ contentUid: content.uid, kind: "submitted", actorUserRef: actor!.userRef, metadata: { version: result.doc.currentVersion }, requestId });

  return { ok: true, data: await toContentDto(result.doc) };
}

// ---- Review decision ----

const reviewDecisionValueSchema = z.enum(["APPROVED", "CHANGES_REQUIRED", "REJECTED"]);
const reviewContentDecisionInputSchema = z
  .object({
    decision: reviewDecisionValueSchema,
    reviewedVersion: z.number().int().min(1),
    comment: z.string().min(1).max(2000).optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type ReviewContentDecisionInput = z.input<typeof reviewContentDecisionInputSchema>;

type ReviewTxResult = { kind: "ok"; doc: ContentDoc } | { kind: "stale" } | { kind: "invalid" } | { kind: "not_found" } | { kind: "stale_decision" };

export async function reviewContentDecision(actor: ActorContext | null, contentRef: unknown, rawInput: unknown, requestId: string): Promise<ContentServiceResult<ContentDto>> {
  const loaded = await loadAuthorizedContent(actor, contentRef, "review_content");
  if (!loaded.ok) return loaded.error;
  const content = loaded.content;

  // Fail-safe: NO_PREPOST_REVIEW must never accept a review call.
  if (content.reviewPolicy !== "REVIEW_REQUIRED") {
    return contentInvalidInputResult("This Content does not use pre-post review.");
  }

  const parsed = reviewContentDecisionInputSchema.safeParse(rawInput);
  if (!parsed.success) return contentInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if ((CONTENT_REASON_REQUIRED_STATUSES as readonly ContentStatus[]).includes(input.decision) && !input.comment) {
    return contentInvalidInputResult(`A comment is required to record a ${input.decision} decision.`);
  }

  if (!canTransitionLifecycle(content.status, input.decision, CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)) {
    return contentInvalidInputResult(`Cannot move Content from ${content.status} to ${input.decision}.`);
  }

  // Stale-decision check: the reviewer must be deciding on the version
  // that is actually still the latest submitted one.
  if (input.reviewedVersion !== content.lastSubmittedVersion) {
    return { ok: false, code: "stale_write", message: "This decision targets an outdated submitted version. Reload and try again." };
  }

  const now = new Date().toISOString();
  const db = getAdminFirestore();
  const docRef = contentCollection().doc(content.uid);

  const result = await db.runTransaction<ReviewTxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsedCurrent = contentDocSchema.safeParse(snap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const fresh = parsedCurrent.data;

    if (fresh.version !== input.expectedVersion) return { kind: "stale" };
    if (fresh.reviewPolicy !== "REVIEW_REQUIRED") return { kind: "invalid" };
    if (!canTransitionLifecycle(fresh.status, input.decision, CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS)) return { kind: "invalid" };
    // Re-verify the same race a second time, inside the transaction - a
    // resubmission may have landed between the pre-check above and here.
    if (input.reviewedVersion !== fresh.lastSubmittedVersion) return { kind: "stale_decision" };

    const updated: ContentDoc = {
      ...fresh,
      status: input.decision,
      statusReason: input.decision === "CHANGES_REQUIRED" || input.decision === "REJECTED" ? (input.comment ?? null) : null,
      approvedAt: input.decision === "APPROVED" ? (fresh.approvedAt ?? now) : fresh.approvedAt,
      version: fresh.version + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    tx.set(docRef, updated);
    return { kind: "ok", doc: updated };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Content not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Content was changed elsewhere. Reload and try again." };
  if (result.kind === "stale_decision") return { ok: false, code: "stale_write", message: "This decision targets an outdated submitted version. Reload and try again." };
  if (result.kind === "invalid") return contentInvalidInputResult(`Cannot move Content from ${content.status} to ${input.decision}.`);

  await writeContentEvent({
    contentUid: content.uid,
    kind: "review_decision",
    actorUserRef: actor!.userRef,
    metadata: { decision: input.decision, version: input.reviewedVersion, comment: input.comment ?? null },
    requestId,
  });

  return { ok: true, data: await toContentDto(result.doc) };
}

// ---- Add publication evidence ----

const addPublicationEvidenceInputSchema = z
  .object({
    platform: platformIdentifierSchema,
    url: httpsUrlSchema,
    platformContentId: z.string().min(1).max(200).optional(),
    partnerAccountRef: z.string().min(1).optional(),
    publishedAt: z.string().min(1).optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type AddPublicationEvidenceInput = z.input<typeof addPublicationEvidenceInputSchema>;

function receivingStatusesFor(reviewPolicy: ContentDoc["reviewPolicy"]): ReadonlySet<ContentStatus> {
  return reviewPolicy === "REVIEW_REQUIRED" ? new Set(["APPROVED", "POSTED", "COMPLETED"]) : new Set(["IN_PRODUCTION", "POSTED", "COMPLETED"]);
}

type AddEvidenceTxResult =
  | { kind: "ok"; doc: ContentDoc; evidence: PublicationEvidenceItem; transitionedToPosted: boolean; alreadyExisted: boolean }
  | { kind: "stale" }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "too_many" };

// Step 11A section 7: the transactional cross-document claim mirrors
// external-submission-service.ts's submitExternalLinks - every read via
// tx.getAll() before any write.
export async function addPublicationEvidence(actor: ActorContext | null, contentRef: unknown, rawInput: unknown, requestId: string): Promise<ContentServiceResult<ContentDto>> {
  const loaded = await loadAuthorizedContent(actor, contentRef, "manage_content_publication");
  if (!loaded.ok) return loaded.error;
  const content = loaded.content;

  const parsed = addPublicationEvidenceInputSchema.safeParse(rawInput);
  if (!parsed.success) return contentInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (!receivingStatusesFor(content.reviewPolicy).has(content.status)) {
    return contentNotReadyResult("This Content cannot receive publication evidence in its current status.", [
      { code: "CONTENT_NOT_RECEIVING_EVIDENCE", message: `Content status ${content.status} does not accept publication evidence.` },
    ]);
  }

  const platform = input.platform;
  const normalizedUrl = normalizeContentUrl(input.url);

  if (input.partnerAccountRef) {
    const assignment = await getAssignmentDocByRef(content.assignmentRef);
    if (!assignment) return { ok: false, code: "not_found", message: "Owning Assignment not found." };
    const err = await checkPartnerAccountCompatibility(input.partnerAccountRef, assignment, platform);
    if (err) return contentInvalidInputResult(err);
  }

  const urlKey = publicationUrlIdentityKey(platform, normalizedUrl);
  const urlClaimRef = contentPublicationClaimsCollection().doc(contentPublicationClaimId(urlKey));
  const pcidKey = input.platformContentId ? publicationContentIdIdentityKey(platform, input.platformContentId) : null;
  const pcidClaimRef = pcidKey ? contentPublicationClaimsCollection().doc(contentPublicationClaimId(pcidKey)) : null;

  const now = new Date().toISOString();
  const db = getAdminFirestore();
  const contentDocRef = contentCollection().doc(content.uid);

  const result = await db.runTransaction<AddEvidenceTxResult>(async (tx) => {
    const refs = [contentDocRef, urlClaimRef, ...(pcidClaimRef ? [pcidClaimRef] : [])];
    const [contentSnap, urlClaimSnap, pcidClaimSnap] = await tx.getAll(...refs);

    if (!contentSnap!.exists) return { kind: "not_found" };
    const parsedCurrent = contentDocSchema.safeParse(contentSnap!.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const fresh = parsedCurrent.data;

    if (fresh.version !== input.expectedVersion) return { kind: "stale" };
    if (!receivingStatusesFor(fresh.reviewPolicy).has(fresh.status)) return { kind: "invalid" };

    const urlClaim = urlClaimSnap!.exists ? contentPublicationClaimDocSchema.safeParse(urlClaimSnap!.data()) : null;
    if (urlClaim?.success && urlClaim.data.contentUid !== fresh.uid) return { kind: "conflict" };

    const pcidClaim = pcidClaimRef && pcidClaimSnap?.exists ? contentPublicationClaimDocSchema.safeParse(pcidClaimSnap.data()) : null;
    if (pcidClaim?.success && pcidClaim.data.contentUid !== fresh.uid) return { kind: "conflict" };

    const urlOwnedByThis = Boolean(urlClaim?.success && urlClaim.data.contentUid === fresh.uid);
    const pcidOwnedByThis = pcidClaimRef ? Boolean(pcidClaim?.success && pcidClaim.data.contentUid === fresh.uid) : true;

    if (urlOwnedByThis && pcidOwnedByThis) {
      const existingEvidence = fresh.publicationEvidence.find(
        (e) => e.normalizedUrl === normalizedUrl && (!input.platformContentId || e.platformContentId === input.platformContentId),
      );
      if (existingEvidence) {
        // Idempotent retry - already recorded for this exact Content.
        return { kind: "ok", doc: fresh, evidence: existingEvidence, transitionedToPosted: false, alreadyExisted: true };
      }
      // Claim(s) already belong to this Content but no matching evidence
      // item was found (shouldn't normally happen) - fall through to the
      // create path below, which re-writes both the evidence array entry
      // and the claim doc(s).
    }

    if (fresh.publicationEvidence.length >= MAX_PUBLICATION_EVIDENCE_ITEMS) return { kind: "too_many" };

    const evidence = publicationEvidenceItemSchema.parse({
      evidenceId: generatePublicationEvidenceId(),
      platform,
      originalUrl: input.url,
      normalizedUrl,
      platformContentId: input.platformContentId ?? null,
      partnerAccountRef: input.partnerAccountRef ?? null,
      publishedAt: input.publishedAt ?? null,
      recordedAt: now,
      recordedByUserRef: actor!.userRef,
      provenance: "STAFF_RECORDED",
      sourceExternalSubmissionRef: null,
    });

    // First-publication transition: APPROVED (REVIEW_REQUIRED) or
    // IN_PRODUCTION (NO_PREPOST_REVIEW) -> POSTED. Already-POSTED/
    // COMPLETED status is left unchanged - evidence simply appends.
    const firstPublicationStatus: ContentStatus = fresh.reviewPolicy === "REVIEW_REQUIRED" ? "APPROVED" : "IN_PRODUCTION";
    const transitionedToPosted = fresh.status === firstPublicationStatus;

    const updated: ContentDoc = {
      ...fresh,
      publicationEvidence: [...fresh.publicationEvidence, evidence],
      status: transitionedToPosted ? "POSTED" : fresh.status,
      postedAt: transitionedToPosted ? now : fresh.postedAt,
      version: fresh.version + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    tx.set(contentDocRef, updated);
    tx.set(urlClaimRef, contentPublicationClaimDocSchema.parse({ key: urlKey, contentRef: fresh.contentRef, contentUid: fresh.uid, evidenceId: evidence.evidenceId, claimedAt: now }));
    if (pcidClaimRef && pcidKey) {
      tx.set(pcidClaimRef, contentPublicationClaimDocSchema.parse({ key: pcidKey, contentRef: fresh.contentRef, contentUid: fresh.uid, evidenceId: evidence.evidenceId, claimedAt: now }));
    }

    return { kind: "ok", doc: updated, evidence, transitionedToPosted, alreadyExisted: false };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Content not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Content was changed elsewhere. Reload and try again." };
  if (result.kind === "invalid") {
    return contentNotReadyResult("This Content cannot receive publication evidence in its current status.", [
      { code: "CONTENT_NOT_RECEIVING_EVIDENCE", message: `Content status ${content.status} does not accept publication evidence.` },
    ]);
  }
  if (result.kind === "conflict") return contentConflictResult("This URL (or platform content ID) is already claimed by another Content record.");
  if (result.kind === "too_many") return contentInvalidInputResult("This Content has reached the maximum number of publication evidence items.");

  if (!result.alreadyExisted) {
    await writeContentEvent({
      contentUid: content.uid,
      kind: "publication_evidence_added",
      actorUserRef: actor!.userRef,
      metadata: { platform, transitionedToPosted: result.transitionedToPosted },
      requestId,
    });
    if (result.transitionedToPosted) {
      await writeContentEvent({ contentUid: content.uid, kind: "posted", actorUserRef: actor!.userRef, metadata: {}, requestId });
    }
  }

  return { ok: true, data: await toContentDto(result.doc) };
}

// ---- Complete ----

const completeContentInputSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();
export type CompleteContentInput = z.input<typeof completeContentInputSchema>;

type CompleteTxResult =
  | { kind: "ok"; doc: ContentDoc; assignmentCompleted: boolean; freshAssignment: AssignmentDoc | null }
  | { kind: "stale" }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "no_evidence" };

// Step 11A section 8: completes a Content record and, when this is the
// final qualifying required Content for its Assignment, completes the
// Assignment too - in the SAME transaction, via the one shared
// evaluator (countQualifyingContentForAssignment/
// evaluateAssignmentFulfillment in fulfillment-service.ts). Never copies
// Content status into Assignment status directly, never touches
// Campaign or Finance.
export async function completeContent(actor: ActorContext | null, contentRef: unknown, rawInput: unknown, requestId: string): Promise<ContentServiceResult<ContentDto>> {
  const loaded = await loadAuthorizedContent(actor, contentRef, "complete_content");
  if (!loaded.ok) return loaded.error;
  const content = loaded.content;

  const parsed = completeContentInputSchema.safeParse(rawInput);
  if (!parsed.success) return contentInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const table = lifecycleTableFor(content.reviewPolicy);
  if (!canTransitionLifecycle(content.status, "COMPLETED", table)) {
    return contentInvalidInputResult(`Cannot move Content from ${content.status} to COMPLETED.`);
  }

  if (content.publicationEvidence.length === 0) {
    return contentNotReadyResult("Content must have at least one publication evidence item before it can be completed.", [
      { code: "NO_PUBLICATION_EVIDENCE", message: "No publication evidence has been recorded yet." },
    ]);
  }

  const assignment = await getAssignmentDocByRef(content.assignmentRef);
  if (!assignment) return { ok: false, code: "not_found", message: "Owning Assignment not found." };

  const compatibility = await checkContentCompatibleWithAssignment({ platform: content.platform, contentType: content.contentType, partnerAccountRef: content.partnerAccountRef }, assignment);

  const now = new Date().toISOString();
  let willQualify: boolean;
  let qualifyingFulfillment: QualifyingFulfillment;
  if (content.requiredSlotIndex === null) {
    willQualify = false;
    qualifyingFulfillment = qualifyingFulfillmentSchema.parse({ kind: "QUALIFYING_EXTRA", reasonCode: null, determinedAt: now });
  } else if (compatibility.compatible) {
    willQualify = true;
    qualifyingFulfillment = qualifyingFulfillmentSchema.parse({ kind: "QUALIFYING_REQUIRED", reasonCode: null, determinedAt: now });
  } else {
    willQualify = false;
    qualifyingFulfillment = qualifyingFulfillmentSchema.parse({ kind: "NON_QUALIFYING", reasonCode: "OBLIGATION_MISMATCH", determinedAt: now });
  }

  const db = getAdminFirestore();
  const contentDocRef = contentCollection().doc(content.uid);

  const result = await db.runTransaction<CompleteTxResult>(async (tx) => {
    const contentSnap = await tx.get(contentDocRef);
    if (!contentSnap.exists) return { kind: "not_found" };
    const parsedCurrent = contentDocSchema.safeParse(contentSnap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const freshContent = parsedCurrent.data;

    if (freshContent.version !== input.expectedVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(freshContent.status, "COMPLETED", table)) return { kind: "invalid" };
    if (freshContent.publicationEvidence.length === 0) return { kind: "no_evidence" };

    const assignmentSnap = await tx.get(assignmentsCollection().where("assignmentRef", "==", freshContent.assignmentRef).limit(1));
    const parsedAssignment = !assignmentSnap.empty ? assignmentDocSchema.safeParse(assignmentSnap.docs[0]!.data()) : null;
    const freshAssignment = parsedAssignment?.success ? parsedAssignment.data : null;

    const qualifyingCount = freshAssignment
      ? await countQualifyingContentForAssignment(freshAssignment.assignmentRef, tx, { contentUid: freshContent.uid, willQualify })
      : 0;
    const requiredCount = freshAssignment?.brief.requiredCount ?? 1;
    const wouldFulfillAssignment = freshAssignment ? qualifyingCount >= requiredCount : false;

    const updatedContent: ContentDoc = {
      ...freshContent,
      status: "COMPLETED",
      completedAt: now,
      qualifyingFulfillment,
      version: freshContent.version + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    tx.set(contentDocRef, updatedContent);

    let assignmentCompleted = false;
    if (freshAssignment && wouldFulfillAssignment && freshAssignment.status === "IN_PROGRESS") {
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
  if (result.kind === "invalid") return contentInvalidInputResult(`Cannot move Content from ${content.status} to COMPLETED.`);
  if (result.kind === "no_evidence") {
    return contentNotReadyResult("Content must have at least one publication evidence item before it can be completed.", [
      { code: "NO_PUBLICATION_EVIDENCE", message: "No publication evidence has been recorded yet." },
    ]);
  }

  await writeContentEvent({ contentUid: content.uid, kind: "completed", actorUserRef: actor!.userRef, metadata: { qualifyingKind: qualifyingFulfillment.kind }, requestId });

  // The ONE place Content is allowed to write into Assignment's own
  // event history - only as a direct, explained consequence of the same
  // transaction that just completed this Content, never a separate
  // uncoordinated write.
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

  const table = lifecycleTableFor(content.reviewPolicy);
  // This transition table already structurally forbids cancelling
  // POSTED/COMPLETED (neither state's CANCELLED predecessor list
  // includes them, in either review-policy table) - no separate "has
  // publication evidence" check is layered on top; the table IS that
  // check.
  if (!canTransitionLifecycle(content.status, "CANCELLED", table)) {
    return contentInvalidInputResult(`Cannot move Content from ${content.status} to CANCELLED.`);
  }

  const now = new Date().toISOString();
  const db = getAdminFirestore();
  const docRef = contentCollection().doc(content.uid);
  const slotClaimRef = content.requiredSlotIndex !== null ? contentRequiredSlotClaimsCollection().doc(contentRequiredSlotClaimDocId(content.assignmentRef, content.requiredSlotIndex)) : null;

  const result = await db.runTransaction<CancelTxResult>(async (tx) => {
    const refs = [docRef, ...(slotClaimRef ? [slotClaimRef] : [])];
    const snaps = await tx.getAll(...refs);
    const contentSnap = snaps[0]!;
    if (!contentSnap.exists) return { kind: "not_found" };
    const parsedCurrent = contentDocSchema.safeParse(contentSnap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const fresh = parsedCurrent.data;

    if (fresh.version !== input.expectedVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(fresh.status, "CANCELLED", table)) return { kind: "invalid" };

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

    if (slotClaimRef && fresh.requiredSlotIndex !== null) {
      let claimedAt = now;
      const existingClaimSnap = snaps[1];
      if (existingClaimSnap?.exists) {
        const parsedClaim = contentRequiredSlotClaimDocSchema.safeParse(existingClaimSnap.data());
        if (parsedClaim.success) claimedAt = parsedClaim.data.claimedAt;
      }
      tx.set(
        slotClaimRef,
        contentRequiredSlotClaimDocSchema.parse({
          assignmentRef: fresh.assignmentRef,
          slotIndex: fresh.requiredSlotIndex,
          contentRef: fresh.contentRef,
          contentUid: fresh.uid,
          state: "RELEASED",
          claimedAt,
          releasedAt: now,
        }),
      );
    }

    return { kind: "ok", doc: updated };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Content not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Content was changed elsewhere. Reload and try again." };
  if (result.kind === "invalid") return contentInvalidInputResult(`Cannot move Content from ${content.status} to CANCELLED.`);

  await writeContentEvent({
    contentUid: content.uid,
    kind: "cancelled",
    actorUserRef: actor!.userRef,
    metadata: { reason: input.reason, releasedSlotIndex: content.requiredSlotIndex },
    requestId,
  });

  return { ok: true, data: await toContentDto(result.doc) };
}
