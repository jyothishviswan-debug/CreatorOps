import { z } from "zod";

import { CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS, CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS, canTransitionLifecycle } from "@/server/authz/lifecycle";
import { getUserDocByRef } from "@/server/authz/firestore";
import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { getAssignmentDocByRef } from "@/server/assignments/firestore";
import { requireAssignmentInScope } from "@/server/assignments/assignments-gate";
import type { AssignmentDoc, AssignmentStatus } from "@/server/assignments/types";
import { getPartnerAccountDocByRef } from "@/server/partners/firestore";
import { getAdminFirestore } from "@/server/firebase/admin";
import { normalizePlatformIdentifier, platformIdentifierSchema } from "@/server/shared/platform";
import { toContentDto, toContentDtos, type ContentDto } from "./client-dto";
import { writeContentEvent, listContentEvents, type ContentEventListCursor } from "./content-events";
import { requireContentAccess, requireContentFeatureAccess, requireContentInScope } from "./content-gate";
import {
  contentCollection,
  contentRequiredSlotClaimDocId,
  contentRequiredSlotClaimsCollection,
  contentVersionsCollection,
  getContentDocByRef,
  listContentDocs,
  type ContentListCursor,
} from "./firestore";
import { generateContentRef } from "./ids";
import {
  contentDocSchema,
  contentInvalidInputResult,
  contentNotReadyResult,
  contentRequiredSlotClaimDocSchema,
  contentUnauthorizedResult,
  contentVersionDocSchema,
  type ContentDoc,
  type ContentEvent,
  type ContentServiceResult,
  type ContentStatus,
} from "./types";

// Assignment states that permit generating new Content under it, and
// that permit starting production - Step 11A section 1/3's own shared
// rule ("never ASSIGNED-only, never a superset either"). COMPLETED is
// deliberately NOT included - once an Assignment is COMPLETED, ALL new
// Content generation (required or asExtra) is blocked, matching the
// spec's own explicit "COMPLETED is never in that set" instruction.
export const ASSIGNMENT_STATES_ALLOWING_CONTENT_GENERATION: ReadonlySet<AssignmentStatus> = new Set(["ASSIGNED", "ACCEPTED", "IN_PROGRESS"]);

// Shared cross-record validation: a Partner Account must belong to the
// Assignment's own Partner, be inside its own restricted account set
// (when that set is non-empty), and match the Content's own platform.
// Returns null when compatible, or a human-readable message otherwise.
// Exported for content-lifecycle-service.ts's own reuse (publication
// evidence, completion's obligation-compatibility re-check).
export async function checkPartnerAccountCompatibility(partnerAccountRef: string, assignment: AssignmentDoc, platform: string): Promise<string | null> {
  const account = await getPartnerAccountDocByRef(partnerAccountRef);
  if (!account) return `partnerAccountRef "${partnerAccountRef}" does not resolve to a real Partner Account.`;
  if (account.partnerRef !== assignment.partnerRef) return `Partner Account "${partnerAccountRef}" does not belong to this Assignment's Partner.`;
  if (assignment.partnerAccountRefs.length > 0 && !assignment.partnerAccountRefs.includes(partnerAccountRef)) {
    return `Partner Account "${partnerAccountRef}" is not one of this Assignment's own restricted accounts.`;
  }
  if (normalizePlatformIdentifier(account.platform) !== platform) {
    return `Partner Account "${partnerAccountRef}" does not match platform "${platform}".`;
  }
  return null;
}

export type AssignmentCompatibilityCheck = { compatible: true } | { compatible: false; message: string };

// Re-derives, against the CURRENT owning Assignment brief, whether a
// Content record's own platform/contentType/partnerAccountRef are still
// permitted - used both by generation (a fresh check) and completion
// (Step 11A section 8's own re-check that decides QUALIFYING_REQUIRED
// vs NON_QUALIFYING/OBLIGATION_MISMATCH).
export async function checkContentCompatibleWithAssignment(
  content: { platform: string; contentType: string; partnerAccountRef: string | null },
  assignment: AssignmentDoc,
): Promise<AssignmentCompatibilityCheck> {
  if (assignment.brief.platforms.length === 0 || !assignment.brief.platforms.includes(content.platform)) {
    return { compatible: false, message: `Platform "${content.platform}" is no longer permitted for this Assignment.` };
  }
  if (assignment.brief.formats.length > 0 && !assignment.brief.formats.includes(content.contentType)) {
    return { compatible: false, message: `Content type "${content.contentType}" is no longer one of this Assignment's own permitted formats.` };
  }
  if (content.partnerAccountRef) {
    const err = await checkPartnerAccountCompatibility(content.partnerAccountRef, assignment, content.platform);
    if (err) return { compatible: false, message: err };
  }
  return { compatible: true };
}

// Gate-then-load helper mirroring loadAuthorizedAssignment exactly.
export async function loadAuthorizedContent(
  actor: ActorContext | null,
  contentRef: unknown,
  action: Parameters<typeof requireContentAccess>[1],
): Promise<{ ok: true; content: ContentDoc } | { ok: false; error: ContentServiceResult<never> }> {
  const gate = await requireContentAccess(actor, action);
  if (!gate.ok) return { ok: false, error: contentUnauthorizedResult(gate.reason) };

  if (typeof contentRef !== "string" || contentRef.length === 0) return { ok: false, error: contentInvalidInputResult("Missing contentRef.") };
  const content = await getContentDocByRef(contentRef);
  if (!content) return { ok: false, error: { ok: false, code: "not_found", message: "Content not found." } };

  const scopeCheck = await requireContentInScope(actor!, content);
  if (!scopeCheck.ok) return { ok: false, error: contentUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, content };
}

// ---- Generate Content from Assignment ----

const generateContentInputSchema = z
  .object({
    assignmentRef: z.string().min(1),
    platform: platformIdentifierSchema,
    contentType: z.string().min(1).max(60),
    partnerAccountRef: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
    dueAt: z.string().min(1).optional(),
    asExtra: z.boolean().optional(),
  })
  .strict();
export type GenerateContentFromAssignmentInput = z.input<typeof generateContentInputSchema>;

type CreateContentTxResult = { kind: "created"; doc: ContentDoc } | { kind: "no_slot" };

type FreeSlot = { requiredSlotIndex: number; claimDocRef: FirebaseFirestore.DocumentReference; supersedesContentRef: string | null };

async function findFreeRequiredSlot(tx: FirebaseFirestore.Transaction, assignmentRef: string, requiredCount: number): Promise<FreeSlot | null> {
  for (let slotIndex = 0; slotIndex < requiredCount; slotIndex += 1) {
    const ref = contentRequiredSlotClaimsCollection().doc(contentRequiredSlotClaimDocId(assignmentRef, slotIndex));
    const snap = await tx.get(ref);
    if (!snap.exists) return { requiredSlotIndex: slotIndex, claimDocRef: ref, supersedesContentRef: null };
    const claim = contentRequiredSlotClaimDocSchema.safeParse(snap.data());
    if (claim.success && claim.data.state === "RELEASED") {
      return { requiredSlotIndex: slotIndex, claimDocRef: ref, supersedesContentRef: claim.data.contentRef };
    }
    // CLAIMED - this slot is not free, keep scanning.
  }
  return null;
}

// Step 11A section 1: generate a new Content record for an Assignment,
// race-safely claiming a required-obligation slot (or, for asExtra,
// creating an unconstrained non-obligation record with no claim at all).
export async function generateContentFromAssignment(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<ContentServiceResult<ContentDto>> {
  const gate = await requireContentAccess(actor, "create");
  if (!gate.ok) return contentUnauthorizedResult(gate.reason);

  const parsed = generateContentInputSchema.safeParse(rawInput);
  if (!parsed.success) return contentInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const assignment = await getAssignmentDocByRef(input.assignmentRef);
  if (!assignment) return { ok: false, code: "not_found", message: "Assignment not found." };

  const scopeCheck = await requireAssignmentInScope(actor!, assignment);
  if (!scopeCheck.ok) return contentUnauthorizedResult(scopeCheck.reason);

  if (!ASSIGNMENT_STATES_ALLOWING_CONTENT_GENERATION.has(assignment.status)) {
    return contentInvalidInputResult(`Cannot generate Content while the Assignment is ${assignment.status}.`);
  }

  const platform = input.platform;
  if (assignment.brief.platforms.length === 0) {
    return contentInvalidInputResult("No platforms are permitted for this Assignment yet.");
  }
  if (!assignment.brief.platforms.includes(platform)) {
    return contentInvalidInputResult(`Platform "${platform}" is not permitted for this Assignment.`);
  }

  if (assignment.brief.formats.length > 0 && !assignment.brief.formats.includes(input.contentType)) {
    return contentInvalidInputResult(`Content type "${input.contentType}" is not one of this Assignment's own permitted formats.`);
  }

  if (input.partnerAccountRef) {
    const err = await checkPartnerAccountCompatibility(input.partnerAccountRef, assignment, platform);
    if (err) return contentInvalidInputResult(err);
  }

  const dueAt: string | null = input.dueAt ?? assignment.brief.dueAt ?? null;
  if (input.dueAt && assignment.brief.dueAt && input.dueAt > assignment.brief.dueAt) {
    return contentInvalidInputResult("Content dueAt cannot be later than the Assignment's own dueAt.");
  }

  const requiredCount = assignment.brief.requiredCount ?? 1;
  const now = new Date().toISOString();
  const uid = contentCollection().doc().id;
  const contentRef = generateContentRef();
  const newContentDocRef = contentCollection().doc(uid);

  const db = getAdminFirestore();
  const txResult = await db.runTransaction<CreateContentTxResult>(async (tx) => {
    let requiredSlotIndex: number | null = null;
    let supersedesContentRef: string | null = null;
    let claimDocRef: FirebaseFirestore.DocumentReference | null = null;

    if (!input.asExtra) {
      const free = await findFreeRequiredSlot(tx, assignment.assignmentRef, requiredCount);
      if (!free) return { kind: "no_slot" };
      requiredSlotIndex = free.requiredSlotIndex;
      claimDocRef = free.claimDocRef;
      supersedesContentRef = free.supersedesContentRef;
    }

    const doc: ContentDoc = contentDocSchema.parse({
      uid,
      contentRef,
      version: 1,
      assignmentRef: assignment.assignmentRef,
      campaignRef: assignment.campaignRef,
      partnerRef: assignment.partnerRef,
      partnerAccountRef: input.partnerAccountRef ?? null,
      platform,
      contentType: input.contentType,
      title: input.title ?? null,
      status: "PLANNED",
      statusReason: null,
      reviewPolicy: assignment.brief.reviewPolicy,
      currentVersion: 0,
      lastSubmittedVersion: null,
      publicationEvidence: [],
      qualifyingFulfillment: null,
      requiredSlotIndex,
      supersedesContentRef,
      dueAt,
      productionStartedAt: null,
      submittedAt: null,
      approvedAt: null,
      postedAt: null,
      completedAt: null,
      cancelledAt: null,
      ownerUid: assignment.ownerUid,
      regionIds: assignment.regionIds,
      teamIds: assignment.teamIds,
      createdAt: now,
      createdByUserRef: actor!.userRef,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });

    tx.set(newContentDocRef, doc);
    if (claimDocRef && requiredSlotIndex !== null) {
      tx.set(
        claimDocRef,
        contentRequiredSlotClaimDocSchema.parse({
          assignmentRef: assignment.assignmentRef,
          slotIndex: requiredSlotIndex,
          contentRef: doc.contentRef,
          contentUid: doc.uid,
          state: "CLAIMED",
          claimedAt: now,
          releasedAt: null,
        }),
      );
    }
    return { kind: "created", doc };
  });

  if (txResult.kind === "no_slot") {
    return contentInvalidInputResult(
      "No required Content slot is available for this Assignment. Pass asExtra to create additional non-obligation Content, or free a slot by cancelling its current holder.",
    );
  }

  await writeContentEvent({
    contentUid: uid,
    kind: "created",
    actorUserRef: actor!.userRef,
    metadata: { assignmentRef: assignment.assignmentRef, platform, contentType: input.contentType, requiredSlotIndex: txResult.doc.requiredSlotIndex },
    requestId,
  });

  return { ok: true, data: await toContentDto(txResult.doc) };
}

// ---- Read ----

export async function getContent(actor: ActorContext | null, contentRef: unknown): Promise<ContentServiceResult<ContentDto>> {
  const gate = await requireContentFeatureAccess(actor);
  if (!gate.ok) return contentUnauthorizedResult(gate.reason);

  if (typeof contentRef !== "string" || contentRef.length === 0) return contentInvalidInputResult("Missing contentRef.");
  const content = await getContentDocByRef(contentRef);
  if (!content) return { ok: false, code: "not_found", message: "Content not found." };

  const scopeCheck = await requireContentInScope(actor!, content);
  if (!scopeCheck.ok) return contentUnauthorizedResult(scopeCheck.reason);

  return { ok: true, data: await toContentDto(content) };
}

export type ListContentInput = {
  limit?: number;
  cursor?: ContentListCursor;
  status?: string;
  assignmentRef?: string;
  campaignRef?: string;
  partnerRef?: string;
  platform?: string;
  reviewPolicy?: string;
  assignedToMe?: boolean;
};

export async function listContent(actor: ActorContext | null, input: ListContentInput): Promise<ContentServiceResult<{ content: ContentDto[]; nextCursor: ContentListCursor | null }>> {
  const gate = await requireContentFeatureAccess(actor);
  if (!gate.ok) return contentUnauthorizedResult(gate.reason);

  const grants = await getActorScopeGrants(actor!);
  const page = await listContentDocs({
    limit: input.limit ?? 20,
    cursor: input.cursor,
    actorUid: actor!.uid,
    grants,
    hasGlobal: hasGlobalScope(grants),
    status: input.status,
    assignmentRef: input.assignmentRef,
    campaignRef: input.campaignRef,
    partnerRef: input.partnerRef,
    platform: input.platform ? normalizePlatformIdentifier(input.platform) : undefined,
    reviewPolicy: input.reviewPolicy,
    ownerUid: input.assignedToMe ? actor!.uid : undefined,
  });

  return { ok: true, data: { content: await toContentDtos(page.content), nextCursor: page.nextCursor } };
}

const listContentHistoryInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.object({ createdAt: z.string().min(1), id: z.string().min(1) }).optional(),
});
export type ListContentHistoryInput = z.input<typeof listContentHistoryInputSchema>;
export type ContentHistoryEventDto = ContentEvent & { id: string; actorDisplayName: string | null };

export async function getContentHistory(
  actor: ActorContext | null,
  contentRef: unknown,
  rawInput: unknown,
): Promise<ContentServiceResult<{ events: ContentHistoryEventDto[]; nextCursor: ContentEventListCursor | null }>> {
  const gate = await requireContentFeatureAccess(actor);
  if (!gate.ok) return contentUnauthorizedResult(gate.reason);

  if (typeof contentRef !== "string" || contentRef.length === 0) return contentInvalidInputResult("Missing contentRef.");
  const content = await getContentDocByRef(contentRef);
  if (!content) return { ok: false, code: "not_found", message: "Content not found." };

  const scopeCheck = await requireContentInScope(actor!, content);
  if (!scopeCheck.ok) return contentUnauthorizedResult(scopeCheck.reason);

  const parsed = listContentHistoryInputSchema.safeParse(rawInput);
  if (!parsed.success) return contentInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listContentEvents(content.uid, { limit: parsed.data.limit ?? 20, cursor: parsed.data.cursor });

  const uniqueActorRefs = [...new Set(page.events.map((e) => e.actorUserRef))];
  const actorEntries = await Promise.all(uniqueActorRefs.map(async (ref) => [ref, (await getUserDocByRef(ref))?.displayName ?? null] as const));
  const actorNames = new Map(actorEntries);

  return { ok: true, data: { events: page.events.map((e) => ({ ...e, actorDisplayName: actorNames.get(e.actorUserRef) ?? null })), nextCursor: page.nextCursor } };
}

// ---- Start production ----

const startContentProductionInputSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();
export type StartContentProductionInput = z.input<typeof startContentProductionInputSchema>;

type LifecycleTxResult = { kind: "ok"; doc: ContentDoc } | { kind: "idempotent"; doc: ContentDoc } | { kind: "stale" } | { kind: "invalid" } | { kind: "not_found" };

function lifecycleTableFor(reviewPolicy: ContentDoc["reviewPolicy"]) {
  return reviewPolicy === "REVIEW_REQUIRED" ? CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS : CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS;
}

export async function startContentProduction(actor: ActorContext | null, contentRef: unknown, rawInput: unknown, requestId: string): Promise<ContentServiceResult<ContentDto>> {
  const loaded = await loadAuthorizedContent(actor, contentRef, "manage_content_production");
  if (!loaded.ok) return loaded.error;
  const content = loaded.content;

  const parsed = startContentProductionInputSchema.safeParse(rawInput);
  if (!parsed.success) return contentInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const assignment = await getAssignmentDocByRef(content.assignmentRef);
  if (!assignment || !ASSIGNMENT_STATES_ALLOWING_CONTENT_GENERATION.has(assignment.status)) {
    return contentNotReadyResult("The owning Assignment is no longer operational.", [
      { code: "ASSIGNMENT_NOT_OPERATIONAL", message: "The owning Assignment must be ASSIGNED, ACCEPTED, or IN_PROGRESS to start production." },
    ]);
  }

  // Idempotent success - a retry against an already-IN_PRODUCTION record
  // is a no-op, never a stale/invalid error.
  if (content.status === "IN_PRODUCTION") {
    return { ok: true, data: await toContentDto(content) };
  }

  const table = lifecycleTableFor(content.reviewPolicy);
  if (!canTransitionLifecycle(content.status, "IN_PRODUCTION", table)) {
    return contentInvalidInputResult(`Cannot move Content from ${content.status} to IN_PRODUCTION.`);
  }

  const now = new Date().toISOString();
  const db = getAdminFirestore();
  const docRef = contentCollection().doc(content.uid);

  const result = await db.runTransaction<LifecycleTxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsedCurrent = contentDocSchema.safeParse(snap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const fresh = parsedCurrent.data;

    if (fresh.version !== input.expectedVersion) return { kind: "stale" };
    if (fresh.status === "IN_PRODUCTION") return { kind: "idempotent", doc: fresh };
    if (!canTransitionLifecycle(fresh.status, "IN_PRODUCTION", table)) return { kind: "invalid" };

    const updated: ContentDoc = {
      ...fresh,
      status: "IN_PRODUCTION",
      productionStartedAt: fresh.productionStartedAt ?? now,
      version: fresh.version + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };
    tx.set(docRef, updated);
    return { kind: "ok", doc: updated };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Content not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Content was changed elsewhere. Reload and try again." };
  if (result.kind === "invalid") return contentInvalidInputResult(`Cannot move Content from ${content.status} to IN_PRODUCTION.`);
  if (result.kind === "idempotent") return { ok: true, data: await toContentDto(result.doc) };

  await writeContentEvent({ contentUid: content.uid, kind: "production_started", actorUserRef: actor!.userRef, metadata: {}, requestId });

  return { ok: true, data: await toContentDto(result.doc) };
}

// ---- Save version ----

const saveContentVersionInputSchema = z
  .object({
    captionText: z.string().min(1).max(5000).nullable().optional(),
    sourceUrl: z.string().min(1).max(1000).nullable().optional(),
    submissionNotes: z.string().min(1).max(2000).nullable().optional(),
    attachmentRefs: z.array(z.string().min(1).max(500)).max(20).optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type SaveContentVersionInput = z.input<typeof saveContentVersionInputSchema>;

const LEGAL_VERSION_SAVE_STATUSES: ReadonlySet<ContentStatus> = new Set(["IN_PRODUCTION", "CHANGES_REQUIRED"]);

type SaveVersionTxResult = { kind: "ok"; doc: ContentDoc; versionNumber: number } | { kind: "stale" } | { kind: "invalid" } | { kind: "not_found" };

// Step 11A section 4: appends a new immutable version snapshot - never
// overwrites an old one, and never itself changes status (a saved
// version is production work, not a submission).
export async function saveContentVersion(actor: ActorContext | null, contentRef: unknown, rawInput: unknown, requestId: string): Promise<ContentServiceResult<ContentDto>> {
  const loaded = await loadAuthorizedContent(actor, contentRef, "manage_content_production");
  if (!loaded.ok) return loaded.error;
  const content = loaded.content;

  const parsed = saveContentVersionInputSchema.safeParse(rawInput);
  if (!parsed.success) return contentInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (!LEGAL_VERSION_SAVE_STATUSES.has(content.status)) {
    return contentInvalidInputResult("Content can only be revised while in production or after changes were requested.");
  }

  const now = new Date().toISOString();
  const db = getAdminFirestore();
  const contentDocRef = contentCollection().doc(content.uid);

  const result = await db.runTransaction<SaveVersionTxResult>(async (tx) => {
    const snap = await tx.get(contentDocRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsedCurrent = contentDocSchema.safeParse(snap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const fresh = parsedCurrent.data;

    if (fresh.version !== input.expectedVersion) return { kind: "stale" };
    if (!LEGAL_VERSION_SAVE_STATUSES.has(fresh.status)) return { kind: "invalid" };

    const versionNumber = fresh.currentVersion + 1;
    const versionUid = contentVersionsCollection(fresh.uid).doc().id;
    const versionDoc = contentVersionDocSchema.parse({
      uid: versionUid,
      versionNumber,
      captionText: input.captionText ?? null,
      sourceUrl: input.sourceUrl ?? null,
      submissionNotes: input.submissionNotes ?? null,
      attachmentRefs: input.attachmentRefs ?? [],
      createdAt: now,
      createdByUserRef: actor!.userRef,
    });
    tx.set(contentVersionsCollection(fresh.uid).doc(versionUid), versionDoc);

    const updated: ContentDoc = { ...fresh, currentVersion: versionNumber, version: fresh.version + 1, updatedAt: now, updatedByUserRef: actor!.userRef };
    tx.set(contentDocRef, updated);
    return { kind: "ok", doc: updated, versionNumber };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Content not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Content was changed elsewhere. Reload and try again." };
  if (result.kind === "invalid") return contentInvalidInputResult("Content can only be revised while in production or after changes were requested.");

  await writeContentEvent({ contentUid: content.uid, kind: "version_saved", actorUserRef: actor!.userRef, metadata: { versionNumber: result.versionNumber }, requestId });

  return { ok: true, data: await toContentDto(result.doc) };
}

export { lifecycleTableFor };
