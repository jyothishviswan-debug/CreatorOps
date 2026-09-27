import type { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { toAttachmentDto, toEventDto, toNoteDto, toNoteVersionDto, type NoteDto, type NotesMeetingsEventDto, type NoteVersionDto } from "./client-dto";
import { resolveDisplayName, resolveDisplayNames } from "./display-names";
import { listAttachmentMetadataByParent, listNoteEventDocs, listNoteVersionDocs, noteEventsCollection, notesCollection, txCreateNoteVersion, txGetNoteHead, txSetNoteHead } from "./firestore";
import { generateNoteRef } from "./ids";
import { appendEvent } from "./notes-meetings-events";
import { canViewSensitiveNotesMeetings, loadAuthorizedNote, requireOwnerAccess } from "./notes-meetings-gate";
import {
  archiveNoteInputSchema,
  createNoteInputSchema,
  listNotesQuerySchema,
  noteHeadDocSchema,
  noteVersionDocSchema,
  notesMeetingsInvalidInputResult,
  notesMeetingsNotFoundResult,
  notesMeetingsStaleResult,
  reviseNoteInputSchema,
  DEFAULT_NOTE_PAGE_SIZE,
  type ArchiveNoteInput,
  type CreateNoteInput,
  type ListNotesQuery,
  type NoteHeadDoc,
  type NotesMeetingsServiceResult,
  type NoteVersionDoc,
  type ReviseNoteInput,
} from "./types";

// Notes/Meetings Completion (spec sections 2A/6/12): Note authoring - create, get, list, revise
// (history-safe: a new immutable version is appended, never a destructive rewrite), archive (never a
// hard delete - protected history is preserved). Mirrors src/server/operations/task-service.ts's own
// shape exactly.

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

async function buildNoteDto(head: NoteHeadDoc, version: NoteVersionDoc | null, sensitiveVisible: boolean, ownerDisplayName: string | null): Promise<NoteDto> {
  const names = await resolveDisplayNames([head.createdByUserRef, head.updatedByUserRef, head.archivedByUserRef]);
  const attachmentDocs = head.attachmentRefs.length > 0 ? await listAttachmentMetadataByParent(head.noteRef) : [];
  const uploaderNames = await resolveDisplayNames(attachmentDocs.map((a) => a.uploadedByUserRef));
  const attachments = attachmentDocs.map((a) => toAttachmentDto(a, uploaderNames.get(a.uploadedByUserRef) ?? null));
  return toNoteDto(head, version, { owner: { ownerType: head.owner.ownerType, ownerRef: head.owner.ownerRef, ownerDisplayName }, sensitiveVisible, names, attachments });
}

export async function createNote(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<NotesMeetingsServiceResult<NoteDto>> {
  const parsed = createNoteInputSchema.safeParse(rawInput);
  if (!parsed.success) return notesMeetingsInvalidInputResult(formatIssues(parsed.error));
  const input: CreateNoteInput = parsed.data;

  const gate = await requireOwnerAccess(actor, input.owner.ownerType, input.owner.ownerRef, "manage_notes");
  if (!gate.ok) return gate.error;

  const now = new Date().toISOString();
  const noteRef = generateNoteRef();
  const visibility = input.visibility ?? "STANDARD";
  const version = noteVersionDocSchema.parse({ noteRef, version: 1, body: input.body, changeKind: "created", reason: null, createdAt: now, createdByUserRef: actor!.userRef });
  const head: NoteHeadDoc = noteHeadDocSchema.parse({
    noteRef,
    docVersion: 1,
    owner: input.owner,
    visibility,
    latestVersion: 1,
    status: "ACTIVE",
    attachmentRefs: [],
    display: { bodyPreview: input.body.slice(0, 200), projectedAt: now },
    createdAt: now,
    createdByUserRef: actor!.userRef,
    updatedAt: now,
    updatedByUserRef: actor!.userRef,
  });

  await getAdminFirestore().runTransaction(async (tx) => {
    txCreateNoteVersion(tx, version);
    txSetNoteHead(tx, head);
    appendEvent(tx, noteEventsCollection(noteRef), { kind: "NOTE_CREATED", actorUserRef: actor!.userRef, metadata: { version: 1, ownerType: input.owner.ownerType, ownerRef: input.owner.ownerRef, visibility }, requestId, createdAt: now });
  });

  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);
  return { ok: true, data: await buildNoteDto(head, version, sensitiveVisible, gate.ownerDisplayName) };
}

export async function getNote(actor: ActorContext | null, rawNoteRef: unknown): Promise<NotesMeetingsServiceResult<NoteDto>> {
  const loaded = await loadAuthorizedNote(actor, typeof rawNoteRef === "string" ? rawNoteRef : "");
  if (!loaded.ok) return loaded.error;
  const { head, ownerDisplayName } = loaded.authorized;
  const version = await listNoteVersionDocs(head.noteRef, 1).then((page) => page.versions[0] ?? null);
  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);
  return { ok: true, data: await buildNoteDto(head, version, sensitiveVisible, ownerDisplayName) };
}

export async function listNoteVersions(actor: ActorContext | null, rawNoteRef: unknown): Promise<NotesMeetingsServiceResult<{ versions: NoteVersionDto[] }>> {
  const loaded = await loadAuthorizedNote(actor, typeof rawNoteRef === "string" ? rawNoteRef : "");
  if (!loaded.ok) return loaded.error;
  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);
  const redacted = loaded.authorized.head.visibility === "RESTRICTED" && !sensitiveVisible;
  const page = await listNoteVersionDocs(loaded.authorized.head.noteRef);
  const names = await resolveDisplayNames(page.versions.map((v) => v.createdByUserRef));
  return { ok: true, data: { versions: page.versions.map((v) => toNoteVersionDto(v, redacted, names.get(v.createdByUserRef) ?? null)) } };
}

export async function listNoteEvents(actor: ActorContext | null, rawNoteRef: unknown): Promise<NotesMeetingsServiceResult<{ events: NotesMeetingsEventDto[] }>> {
  const loaded = await loadAuthorizedNote(actor, typeof rawNoteRef === "string" ? rawNoteRef : "");
  if (!loaded.ok) return loaded.error;
  const page = await listNoteEventDocs(loaded.authorized.head.noteRef);
  const names = await resolveDisplayNames(page.events.map((e) => e.actorUserRef));
  return { ok: true, data: { events: page.events.map((e) => toEventDto(e, names)) } };
}

export async function reviseNote(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<NotesMeetingsServiceResult<NoteDto>> {
  const parsed = reviseNoteInputSchema.safeParse(rawInput);
  if (!parsed.success) return notesMeetingsInvalidInputResult(formatIssues(parsed.error));
  const input: ReviseNoteInput = parsed.data;

  const loaded = await loadAuthorizedNote(actor, input.noteRef, "manage_notes");
  if (!loaded.ok) return loaded.error;

  type Outcome = { kind: "ok"; head: NoteHeadDoc; version: ReturnType<typeof noteVersionDocSchema.parse> } | { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string };

  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const head = await txGetNoteHead(tx, input.noteRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (head.status === "ARCHIVED") return { kind: "conflict", message: "An archived note cannot be revised." };

    const now = new Date().toISOString();
    const nextNumber = head.latestVersion + 1;
    const version = noteVersionDocSchema.parse({ noteRef: input.noteRef, version: nextNumber, body: input.body, changeKind: "revised", reason: input.reason, createdAt: now, createdByUserRef: actor!.userRef });
    txCreateNoteVersion(tx, version);

    const nextHead: NoteHeadDoc = { ...head, docVersion: head.docVersion + 1, latestVersion: nextNumber, display: { bodyPreview: input.body.slice(0, 200), projectedAt: now }, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetNoteHead(tx, nextHead);

    appendEvent(tx, noteEventsCollection(input.noteRef), { kind: "NOTE_REVISED", actorUserRef: actor!.userRef, metadata: { previousVersion: head.latestVersion, newVersion: nextNumber, reason: input.reason }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead, version };
  });

  if (result.kind === "not_found") return notesMeetingsNotFoundResult();
  if (result.kind === "stale") return notesMeetingsStaleResult();
  if (result.kind === "conflict") return { ok: false, code: "conflict", message: result.message };

  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);
  return { ok: true, data: await buildNoteDto(result.head, result.version, sensitiveVisible, loaded.authorized.ownerDisplayName) };
}

export async function archiveNote(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<NotesMeetingsServiceResult<NoteDto>> {
  const parsed = archiveNoteInputSchema.safeParse(rawInput);
  if (!parsed.success) return notesMeetingsInvalidInputResult(formatIssues(parsed.error));
  const input: ArchiveNoteInput = parsed.data;

  const loaded = await loadAuthorizedNote(actor, input.noteRef, "manage_notes");
  if (!loaded.ok) return loaded.error;

  type Outcome = { kind: "ok"; head: NoteHeadDoc } | { kind: "not_found" } | { kind: "stale" } | { kind: "conflict" };
  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const head = await txGetNoteHead(tx, input.noteRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (head.status === "ARCHIVED") return { kind: "conflict" };

    const now = new Date().toISOString();
    const nextHead: NoteHeadDoc = { ...head, docVersion: head.docVersion + 1, status: "ARCHIVED", archivedAt: now, archivedByUserRef: actor!.userRef, archivedReason: input.reason, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetNoteHead(tx, nextHead);
    appendEvent(tx, noteEventsCollection(input.noteRef), { kind: "NOTE_ARCHIVED", actorUserRef: actor!.userRef, metadata: { reason: input.reason }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind === "not_found") return notesMeetingsNotFoundResult();
  if (result.kind === "stale") return notesMeetingsStaleResult();
  if (result.kind === "conflict") return { ok: false, code: "conflict", message: "This note is already archived." };

  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);
  const version = await listNoteVersionDocs(result.head.noteRef, 1).then((page) => page.versions[0] ?? null);
  return { ok: true, data: await buildNoteDto(result.head, version, sensitiveVisible, loaded.authorized.ownerDisplayName) };
}

export async function listNotes(actor: ActorContext | null, rawQuery: unknown): Promise<NotesMeetingsServiceResult<{ notes: NoteDto[] }>> {
  const parsed = listNotesQuerySchema.safeParse(rawQuery);
  if (!parsed.success) return notesMeetingsInvalidInputResult(formatIssues(parsed.error));
  const query: ListNotesQuery = parsed.data;

  const gate = await requireOwnerAccess(actor, query.owner.ownerType, query.owner.ownerRef);
  if (!gate.ok) return gate.error;

  const limit = query.limit ?? DEFAULT_NOTE_PAGE_SIZE;
  const heads = await listNoteHeadsByOwnerFiltered(query.owner.ownerType, query.owner.ownerRef, query.status, query.authorUserRef, limit);
  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);

  const notes = await Promise.all(
    heads.map(async (head) => {
      const version = await listNoteVersionDocs(head.noteRef, 1).then((page) => page.versions[0] ?? null);
      return buildNoteDto(head, version, sensitiveVisible, gate.ownerDisplayName);
    }),
  );
  return { ok: true, data: { notes } };
}

async function listNoteHeadsByOwnerFiltered(ownerType: string, ownerRef: string, status: string | undefined, authorUserRef: string | undefined, limit: number): Promise<NoteHeadDoc[]> {
  let query = notesCollection().where("owner.ownerType", "==", ownerType).where("owner.ownerRef", "==", ownerRef) as FirebaseFirestore.Query;
  if (status) query = query.where("status", "==", status);
  const snapshot = await query.orderBy("createdAt", "desc").limit(Math.min(limit, 100) * (authorUserRef ? 4 : 1)).get();
  const heads: NoteHeadDoc[] = [];
  for (const doc of snapshot.docs) {
    const parsed = noteHeadDocSchema.safeParse(doc.data());
    if (parsed.success && (!authorUserRef || parsed.data.createdByUserRef === authorUserRef)) heads.push(parsed.data);
    if (heads.length >= limit) break;
  }
  return heads;
}

export { resolveDisplayName };
