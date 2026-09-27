import type { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { toActionItemDto, toActionItemVersionDto, toEventDto, withAssignee, type ActionItemDto, type ActionItemVersionDto, type NotesMeetingsEventDto } from "./client-dto";
import { resolveDisplayNames } from "./display-names";
import { actionItemEventsCollection, actionItemsCollection, getActionItemVersionDoc, listActionItemEventDocs, listActionItemHeadsByMeeting, txCreateActionItemVersion, txGetActionItemHead, txSetActionItemHead } from "./firestore";
import { generateActionItemRef } from "./ids";
import { appendEvent } from "./notes-meetings-events";
import { loadAuthorizedActionItem, loadAuthorizedMeeting } from "./notes-meetings-gate";
import { requireAdmittedActiveUser } from "./participant-guard";
import { resolvePromotedTaskDisplayName } from "./promoted-task-display";
import {
  actionItemHeadDocSchema,
  actionItemVersionDocSchema,
  cancelActionItemInputSchema,
  completeActionItemInputSchema,
  createActionItemInputSchema,
  notesMeetingsInvalidInputResult,
  notesMeetingsNotFoundResult,
  notesMeetingsStaleResult,
  reviseActionItemInputSchema,
  type ActionItemHeadDoc,
  type CancelActionItemInput,
  type CompleteActionItemInput,
  type CreateActionItemInput,
  type NotesMeetingsServiceResult,
  type ReviseActionItemInput,
} from "./types";

// Notes/Meetings Completion (spec sections 2C/8): MeetingActionItem authoring + compact lifecycle
// (OPEN/IN_PROGRESS/DONE/CANCELLED - never mirroring Task's fuller lifecycle). Promotion to an
// Operations Task lives in promotion.ts, kept separate because it is the one place this module
// crosses into another module's write path.

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

// `promotedTaskDisplayName`: when omitted, resolved automatically from head.promotedTaskRef (spec
// section 15 - never a raw ref as a primary label, on ANY read path, not just right after promotion).
// promotion.ts passes an already-resolved value explicitly since it already has one in hand.
async function buildActionItemDto(actor: ActorContext | null, head: ActionItemHeadDoc, assigneeUserRef: string | null, promotedTaskDisplayName?: string | null): Promise<ActionItemDto> {
  const names = await resolveDisplayNames([head.createdByUserRef, head.updatedByUserRef, head.completedByUserRef, head.cancelledByUserRef, head.promotedByUserRef, assigneeUserRef]);
  const resolvedPromotedTaskDisplayName = promotedTaskDisplayName !== undefined ? promotedTaskDisplayName : await resolvePromotedTaskDisplayName(actor, head.promotedTaskRef);
  const dto = toActionItemDto(head, { names, promotedTaskDisplayName: resolvedPromotedTaskDisplayName });
  return withAssignee(dto, assigneeUserRef, names);
}

async function latestAssignee(actionItemRef: string, latestVersion: number): Promise<string | null> {
  const version = await getActionItemVersionDoc(actionItemRef, latestVersion);
  return version?.assigneeUserRef ?? null;
}

export async function createActionItem(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<NotesMeetingsServiceResult<ActionItemDto>> {
  const parsed = createActionItemInputSchema.safeParse(rawInput);
  if (!parsed.success) return notesMeetingsInvalidInputResult(formatIssues(parsed.error));
  const input: CreateActionItemInput = parsed.data;

  const meeting = await loadAuthorizedMeeting(actor, input.meetingRef, "manage_meetings");
  if (!meeting.ok) return meeting.error;
  if (meeting.authorized.head.docVersion !== input.expectedDocVersion) return notesMeetingsStaleResult("The meeting was changed elsewhere. Reload and try again.");
  if (meeting.authorized.head.status === "CANCELLED") return { ok: false, code: "conflict", message: "A cancelled meeting cannot receive new action items." };

  if (input.assigneeUserRef) {
    const check = await requireAdmittedActiveUser(input.assigneeUserRef);
    if (!check.ok) return notesMeetingsInvalidInputResult("The assignee must be an active CreatorOps user.");
  }

  const now = new Date().toISOString();
  const actionItemRef = generateActionItemRef();
  const version = actionItemVersionDocSchema.parse({ actionItemRef, version: 1, text: input.text, assigneeUserRef: input.assigneeUserRef ?? null, dueAt: input.dueAt ?? null, changeKind: "created", reason: null, createdAt: now, createdByUserRef: actor!.userRef });
  const head: ActionItemHeadDoc = actionItemHeadDocSchema.parse({
    actionItemRef,
    meetingRef: input.meetingRef,
    docVersion: 1,
    status: "OPEN",
    latestVersion: 1,
    display: { text: input.text, status: "OPEN", dueAt: input.dueAt ?? null, projectedAt: now },
    createdAt: now,
    createdByUserRef: actor!.userRef,
    updatedAt: now,
    updatedByUserRef: actor!.userRef,
  });

  await getAdminFirestore().runTransaction(async (tx) => {
    txCreateActionItemVersion(tx, version);
    txSetActionItemHead(tx, head);
    appendEvent(tx, actionItemEventsCollection(actionItemRef), { kind: "ACTION_ITEM_CREATED", actorUserRef: actor!.userRef, metadata: { meetingRef: input.meetingRef, version: 1, assigneeUserRef: input.assigneeUserRef ?? undefined, dueAt: input.dueAt ?? undefined }, requestId, createdAt: now });
  });

  return { ok: true, data: await buildActionItemDto(actor, head, input.assigneeUserRef ?? null) };
}

export async function getActionItem(actor: ActorContext | null, rawActionItemRef: unknown): Promise<NotesMeetingsServiceResult<ActionItemDto>> {
  const loaded = await loadAuthorizedActionItem(actor, typeof rawActionItemRef === "string" ? rawActionItemRef : "");
  if (!loaded.ok) return loaded.error;
  const assignee = await latestAssignee(loaded.authorized.head.actionItemRef, loaded.authorized.head.latestVersion);
  return { ok: true, data: await buildActionItemDto(actor, loaded.authorized.head, assignee) };
}

export async function listActionItems(actor: ActorContext | null, rawMeetingRef: unknown): Promise<NotesMeetingsServiceResult<{ actionItems: ActionItemDto[] }>> {
  const meeting = await loadAuthorizedMeeting(actor, typeof rawMeetingRef === "string" ? rawMeetingRef : "");
  if (!meeting.ok) return meeting.error;
  const heads = await listActionItemHeadsByMeeting(meeting.authorized.head.meetingRef);
  const items = await Promise.all(
    heads.map(async (head) => {
      const assignee = await latestAssignee(head.actionItemRef, head.latestVersion);
      return buildActionItemDto(actor, head, assignee);
    }),
  );
  return { ok: true, data: { actionItems: items } };
}

export async function listActionItemVersions(actor: ActorContext | null, rawActionItemRef: unknown): Promise<NotesMeetingsServiceResult<{ versions: ActionItemVersionDto[] }>> {
  const loaded = await loadAuthorizedActionItem(actor, typeof rawActionItemRef === "string" ? rawActionItemRef : "");
  if (!loaded.ok) return loaded.error;
  const snapshot = await actionItemsCollection().doc(loaded.authorized.head.actionItemRef).collection("versions").orderBy("version", "desc").get();
  const versions = snapshot.docs.map((d) => actionItemVersionDocSchema.parse(d.data()));
  const names = await resolveDisplayNames([...versions.map((v) => v.createdByUserRef), ...versions.map((v) => v.assigneeUserRef)]);
  return { ok: true, data: { versions: versions.map((v) => toActionItemVersionDto(v, names)) } };
}

export async function listActionItemEvents(actor: ActorContext | null, rawActionItemRef: unknown): Promise<NotesMeetingsServiceResult<{ events: NotesMeetingsEventDto[] }>> {
  const loaded = await loadAuthorizedActionItem(actor, typeof rawActionItemRef === "string" ? rawActionItemRef : "");
  if (!loaded.ok) return loaded.error;
  const page = await listActionItemEventDocs(loaded.authorized.head.actionItemRef);
  const names = await resolveDisplayNames(page.events.map((e) => e.actorUserRef));
  return { ok: true, data: { events: page.events.map((e) => toEventDto(e, names)) } };
}

export async function reviseActionItem(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<NotesMeetingsServiceResult<ActionItemDto>> {
  const parsed = reviseActionItemInputSchema.safeParse(rawInput);
  if (!parsed.success) return notesMeetingsInvalidInputResult(formatIssues(parsed.error));
  const input: ReviseActionItemInput = parsed.data;

  const loaded = await loadAuthorizedActionItem(actor, input.actionItemRef, "manage_meetings");
  if (!loaded.ok) return loaded.error;

  if (input.assigneeUserRef) {
    const check = await requireAdmittedActiveUser(input.assigneeUserRef);
    if (!check.ok) return notesMeetingsInvalidInputResult("The assignee must be an active CreatorOps user.");
  }

  type Outcome = { kind: "ok"; head: ActionItemHeadDoc; assigneeUserRef: string | null } | { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string };
  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const head = await txGetActionItemHead(tx, input.actionItemRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (head.status === "DONE" || head.status === "CANCELLED") return { kind: "conflict", message: "A done or cancelled action item cannot be revised." };

    const currentSnapshot = await tx.get(actionItemsCollection().doc(input.actionItemRef).collection("versions").doc(String(head.latestVersion)));
    const current = actionItemVersionDocSchema.parse(currentSnapshot.data());

    const now = new Date().toISOString();
    const nextNumber = head.latestVersion + 1;
    const nextText = input.text ?? current.text;
    const nextAssignee = input.assigneeUserRef !== undefined ? input.assigneeUserRef : current.assigneeUserRef;
    const nextDueAt = input.dueAt !== undefined ? input.dueAt : current.dueAt;
    const nextStatus = input.status ?? head.status;

    const version = actionItemVersionDocSchema.parse({ actionItemRef: input.actionItemRef, version: nextNumber, text: nextText, assigneeUserRef: nextAssignee, dueAt: nextDueAt, changeKind: "revised", reason: input.reason, createdAt: now, createdByUserRef: actor!.userRef });
    txCreateActionItemVersion(tx, version);

    const nextHead: ActionItemHeadDoc = { ...head, docVersion: head.docVersion + 1, latestVersion: nextNumber, status: nextStatus, display: { text: nextText, status: nextStatus, dueAt: nextDueAt, projectedAt: now }, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetActionItemHead(tx, nextHead);

    appendEvent(tx, actionItemEventsCollection(input.actionItemRef), { kind: "ACTION_ITEM_REVISED", actorUserRef: actor!.userRef, metadata: { previousVersion: head.latestVersion, newVersion: nextNumber, reason: input.reason, status: nextStatus, previousStatus: head.status, assigneeUserRef: nextAssignee ?? undefined, previousAssigneeUserRef: current.assigneeUserRef ?? undefined, dueAt: nextDueAt ?? undefined }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead, assigneeUserRef: nextAssignee };
  });

  if (result.kind === "not_found") return notesMeetingsNotFoundResult();
  if (result.kind === "stale") return notesMeetingsStaleResult();
  if (result.kind === "conflict") return { ok: false, code: "conflict", message: result.message };
  return { ok: true, data: await buildActionItemDto(actor, result.head, result.assigneeUserRef) };
}

export async function completeActionItem(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<NotesMeetingsServiceResult<ActionItemDto>> {
  const parsed = completeActionItemInputSchema.safeParse(rawInput);
  if (!parsed.success) return notesMeetingsInvalidInputResult(formatIssues(parsed.error));
  const input: CompleteActionItemInput = parsed.data;

  const loaded = await loadAuthorizedActionItem(actor, input.actionItemRef, "manage_meetings");
  if (!loaded.ok) return loaded.error;

  type Outcome = { kind: "ok"; head: ActionItemHeadDoc } | { kind: "not_found" } | { kind: "stale" } | { kind: "conflict" };
  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const head = await txGetActionItemHead(tx, input.actionItemRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (head.status === "DONE" || head.status === "CANCELLED") return { kind: "conflict" };
    const now = new Date().toISOString();
    const nextHead: ActionItemHeadDoc = { ...head, docVersion: head.docVersion + 1, status: "DONE", completedAt: now, completedByUserRef: actor!.userRef, display: { ...head.display, status: "DONE" }, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetActionItemHead(tx, nextHead);
    appendEvent(tx, actionItemEventsCollection(input.actionItemRef), { kind: "ACTION_ITEM_COMPLETED", actorUserRef: actor!.userRef, metadata: { status: "DONE", previousStatus: head.status }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind === "not_found") return notesMeetingsNotFoundResult();
  if (result.kind === "stale") return notesMeetingsStaleResult();
  if (result.kind === "conflict") return { ok: false, code: "conflict", message: "This action item is already closed." };
  const assignee = await latestAssignee(result.head.actionItemRef, result.head.latestVersion);
  return { ok: true, data: await buildActionItemDto(actor, result.head, assignee) };
}

export async function cancelActionItem(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<NotesMeetingsServiceResult<ActionItemDto>> {
  const parsed = cancelActionItemInputSchema.safeParse(rawInput);
  if (!parsed.success) return notesMeetingsInvalidInputResult(formatIssues(parsed.error));
  const input: CancelActionItemInput = parsed.data;

  const loaded = await loadAuthorizedActionItem(actor, input.actionItemRef, "manage_meetings");
  if (!loaded.ok) return loaded.error;

  type Outcome = { kind: "ok"; head: ActionItemHeadDoc } | { kind: "not_found" } | { kind: "stale" } | { kind: "conflict" };
  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const head = await txGetActionItemHead(tx, input.actionItemRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (head.status === "DONE" || head.status === "CANCELLED") return { kind: "conflict" };
    const now = new Date().toISOString();
    const nextHead: ActionItemHeadDoc = { ...head, docVersion: head.docVersion + 1, status: "CANCELLED", cancelledAt: now, cancelledByUserRef: actor!.userRef, cancelledReason: input.reason, display: { ...head.display, status: "CANCELLED" }, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetActionItemHead(tx, nextHead);
    appendEvent(tx, actionItemEventsCollection(input.actionItemRef), { kind: "ACTION_ITEM_CANCELLED", actorUserRef: actor!.userRef, metadata: { reason: input.reason, status: "CANCELLED", previousStatus: head.status }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind === "not_found") return notesMeetingsNotFoundResult();
  if (result.kind === "stale") return notesMeetingsStaleResult();
  if (result.kind === "conflict") return { ok: false, code: "conflict", message: "This action item is already closed." };
  const assignee = await latestAssignee(result.head.actionItemRef, result.head.latestVersion);
  return { ok: true, data: await buildActionItemDto(actor, result.head, assignee) };
}

export { buildActionItemDto, latestAssignee };
