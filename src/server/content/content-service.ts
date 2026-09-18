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
  if (!content) return { ok: false, error: { ok: false, code: "not_found", message: "Content not found." } };

  const scopeCheck = await requireContentInScope(actor!, content);
  if (!scopeCheck.ok) return { ok: false, error: contentUnauthorizedResult(scopeCheck.reason) };

  return { ok: true, content };
}

// ---- Resolve-or-create the Assignment's one canonical Content thread ----

type ResolveOrCreateTxResult = { kind: "existing"; doc: ContentDoc } | { kind: "created"; doc: ContentDoc };

// Step 11A.1's sole trusted create entry point for Content, replacing
// the retired generateContentFromAssignment/manual "Plan Content"
// operation entirely. Idempotent get-or-create: the first time a
// submission session is created for an Assignment, this either returns
// its already-existing canonical thread or atomically creates a new one
// (status OPEN) plus its one-per-Assignment uniqueness claim. Called only
// from the session-creation flow in
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
          if (parsed.success) return { kind: "existing", doc: parsed.data };
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
