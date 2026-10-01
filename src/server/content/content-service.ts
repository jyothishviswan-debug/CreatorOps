import { z } from "zod";

import { getUserDocByRef } from "@/server/authz/firestore";
import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { getAssignmentDocByRef } from "@/server/assignments/firestore";
import type { AssignmentStatus } from "@/server/assignments/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { toContentDto, toContentDtos, type ContentDto } from "./client-dto";
import { writeContentEvent, listContentEvents, type ContentEventListCursor } from "./content-events";
import { requireContentAccess, requireContentFeatureAccess, requireContentInScope } from "./content-gate";
import { contentAssignmentThreadClaimsCollection, contentCollection, getContentDocByRef, listContentDocs, type ContentListCursor } from "./firestore";
import { generateContentRef } from "./ids";
import {
  contentAssignmentThreadClaimDocSchema,
  contentDocSchema,
  contentInvalidInputResult,
  contentNotFoundResult,
  contentUnauthorizedResult,
  type ContentDoc,
  type ContentEvent,
  type ContentServiceResult,
} from "./types";

// Step 11A.1: the Assignment states a submission thread may be created
// or used under. COMPLETED is deliberately not included - once the
// Assignment's one canonical thread has been approved (which is what
// completes it), nothing new should spin up under it.
export const ASSIGNMENT_STATES_ALLOWING_CONTENT_GENERATION: ReadonlySet<AssignmentStatus> = new Set(["ASSIGNED", "ACCEPTED", "IN_PROGRESS"]);

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
  if (!content) return { ok: false, error: contentNotFoundResult() };

  // Production hardening (base spec section 4): a scoped-out ref collapses into the SAME neutral
  // not-found outcome as a missing one - see contentNotFoundResult's own comment.
  const scopeCheck = await requireContentInScope(actor!, content);
  if (!scopeCheck.ok) return { ok: false, error: contentNotFoundResult() };

  return { ok: true, content };
}

// ---- Resolve-or-create the Assignment's CURRENT Content thread ----

type ResolveOrCreateTxResult = { kind: "existing"; doc: ContentDoc } | { kind: "created"; doc: ContentDoc };

// Finding #50 (reopened): an Assignment may carry MULTIPLE qualifying
// Content records over its lifetime - one per submission cycle - not
// exactly one forever. The invariant this function (and the claim doc
// below) enforces is "at most one NON-TERMINAL thread per Assignment at a
// time", never "at most one thread ever". Idempotent get-or-create WHILE
// the current cycle is still open: the first time a submission session is
// created for an Assignment, or any time one is created again before the
// current thread reaches a terminal status (APPROVED/CANCELLED), this
// returns that same thread. Once the current thread IS terminal, the next
// call creates a genuinely NEW thread (status OPEN) and re-points the
// claim at it - the claim doc is permanent in that it is never deleted,
// but its payload is repointed, not a one-time write. Called only from
// the session-creation flow in
// @/server/assignments/external-submission-service.ts (a one-directional
// assignments -> content dependency, mirroring content's own existing
// content -> assignments dependency).
export async function resolveOrCreateContentThread(assignmentRef: string, actorUserRef: string, requestId: string): Promise<ContentDoc> {
  const assignment = await getAssignmentDocByRef(assignmentRef);
  if (!assignment) throw new Error(`resolveOrCreateContentThread: Assignment "${assignmentRef}" not found.`);

  const db = getAdminFirestore();
  const claimRef = contentAssignmentThreadClaimsCollection().doc(assignmentRef);
  const now = new Date().toISOString();
  const uid = contentCollection().doc().id;
  const contentRef = generateContentRef();
  const newContentDocRef = contentCollection().doc(uid);

  const result = await db.runTransaction<ResolveOrCreateTxResult>(async (tx) => {
    const claimSnap = await tx.get(claimRef);
    if (claimSnap.exists) {
      const claim = contentAssignmentThreadClaimDocSchema.safeParse(claimSnap.data());
      if (claim.success) {
        const existingSnap = await tx.get(contentCollection().doc(claim.data.contentUid));
        if (existingSnap.exists) {
          const parsed = contentDocSchema.safeParse(existingSnap.data());
          // A non-terminal thread is still the SAME live conversation -
          // reuse it. A terminal one (APPROVED/CANCELLED) has closed its
          // own cycle - fall through and start a genuinely new one,
          // repointing the claim below.
          if (parsed.success && parsed.data.status !== "APPROVED" && parsed.data.status !== "CANCELLED") {
            return { kind: "existing", doc: parsed.data };
          }
        }
      }
    }

    const doc: ContentDoc = contentDocSchema.parse({
      uid,
      contentRef,
      version: 1,
      assignmentRef: assignment.assignmentRef,
      campaignRef: assignment.campaignRef,
      partnerRef: assignment.partnerRef,
      status: "OPEN",
      statusReason: null,
      currentRevisionNumber: 0,
      reviewedRevisionNumber: null,
      currentLinks: [],
      qualifyingFulfillment: null,
      dueAt: assignment.brief.dueAt,
      openedAt: now,
      firstSubmittedAt: null,
      lastSubmittedAt: null,
      approvedAt: null,
      cancelledAt: null,
      ownerUid: assignment.ownerUid,
      regionIds: assignment.regionIds,
      teamIds: assignment.teamIds,
      createdAt: now,
      createdByUserRef: actorUserRef,
      updatedAt: now,
      updatedByUserRef: actorUserRef,
    });

    tx.set(newContentDocRef, doc);
    tx.set(claimRef, contentAssignmentThreadClaimDocSchema.parse({ assignmentRef: assignment.assignmentRef, contentRef: doc.contentRef, contentUid: doc.uid, claimedAt: now }));
    return { kind: "created", doc };
  });

  if (result.kind === "created") {
    await writeContentEvent({ contentUid: result.doc.uid, kind: "created", actorUserRef, metadata: { assignmentRef: assignment.assignmentRef }, requestId });
  }

  return result.doc;
}

// ---- Read ----

export async function getContent(actor: ActorContext | null, contentRef: unknown): Promise<ContentServiceResult<ContentDto>> {
  const gate = await requireContentFeatureAccess(actor);
  if (!gate.ok) return contentUnauthorizedResult(gate.reason);

  if (typeof contentRef !== "string" || contentRef.length === 0) return contentInvalidInputResult("Missing contentRef.");
  const content = await getContentDocByRef(contentRef);
  if (!content) return contentNotFoundResult();

  // Production hardening (base spec section 4): see loadAuthorizedContent's own identical comment.
  const scopeCheck = await requireContentInScope(actor!, content);
  if (!scopeCheck.ok) return contentNotFoundResult();

  return { ok: true, data: await toContentDto(content) };
}

export type ListContentInput = {
  limit?: number;
  cursor?: ContentListCursor;
  status?: string;
  assignmentRef?: string;
  campaignRef?: string;
  partnerRef?: string;
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
  if (!content) return contentNotFoundResult();

  // Production hardening (base spec section 4): see loadAuthorizedContent's own identical comment.
  const scopeCheck = await requireContentInScope(actor!, content);
  if (!scopeCheck.ok) return contentNotFoundResult();

  const parsed = listContentHistoryInputSchema.safeParse(rawInput);
  if (!parsed.success) return contentInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listContentEvents(content.uid, { limit: parsed.data.limit ?? 20, cursor: parsed.data.cursor });

  const uniqueActorRefs = [...new Set(page.events.map((e) => e.actorUserRef))];
  const actorEntries = await Promise.all(uniqueActorRefs.map(async (ref) => [ref, (await getUserDocByRef(ref))?.displayName ?? null] as const));
  const actorNames = new Map(actorEntries);

  return { ok: true, data: { events: page.events.map((e) => ({ ...e, actorDisplayName: actorNames.get(e.actorUserRef) ?? null })), nextCursor: page.nextCursor } };
}
