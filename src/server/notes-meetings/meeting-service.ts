import type { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { notifyMeetingParticipants, notifyMeetingRevised } from "@/server/notifications";

import { toAttachmentDto, toEventDto, toMeetingDto, toMeetingVersionDto, type MeetingDto, type MeetingVersionDto, type NotesMeetingsEventDto } from "./client-dto";
import { resolveDisplayNames } from "./display-names";
import { listAttachmentMetadataByParent, listMeetingEventDocs, listMeetingVersionDocs, meetingEventsCollection, meetingsCollection, txCreateMeetingVersion, txGetMeetingHead, txSetMeetingHead } from "./firestore";
import { generateMeetingRef } from "./ids";
import { appendEvent } from "./notes-meetings-events";
import { canViewSensitiveNotesMeetings, loadAuthorizedMeeting, requireOwnerAccess } from "./notes-meetings-gate";
import { requireAdmittedActiveUser } from "./participant-guard";
import {
  cancelMeetingInputSchema,
  createMeetingInputSchema,
  listMeetingsQuerySchema,
  meetingHeadDocSchema,
  meetingVersionDocSchema,
  notesMeetingsInvalidInputResult,
  notesMeetingsNotFoundResult,
  notesMeetingsStaleResult,
  reviseMeetingInputSchema,
  DEFAULT_MEETING_PAGE_SIZE,
  type CancelMeetingInput,
  type CreateMeetingInput,
  type ListMeetingsQuery,
  type MeetingHeadDoc,
  type MeetingVersionDoc as MeetingVersionRawDoc,
  type NotesMeetingsServiceResult,
  type ReviseMeetingInput,
} from "./types";

// Notes/Meetings Completion (spec sections 2B/7/12): Meeting/MoM authoring - create, get, list,
// revise (a new immutable version each time - participants/decisions/summary all preserved across
// revisions), cancel. Same head+version+event shape as note-service.ts/Task.

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

async function namesForVersion(head: MeetingHeadDoc, version: MeetingVersionRawDoc | null) {
  const participantRefs = version?.participants.map((p) => p.userRef) ?? [];
  return resolveDisplayNames([head.organizerUserRef, head.createdByUserRef, head.updatedByUserRef, head.cancelledByUserRef, ...participantRefs]);
}

async function buildMeetingDto(head: MeetingHeadDoc, version: MeetingVersionRawDoc | null, sensitiveVisible: boolean, ownerDisplayName: string | null): Promise<MeetingDto> {
  const names = await namesForVersion(head, version);
  const attachmentDocs = head.attachmentRefs.length > 0 ? await listAttachmentMetadataByParent(head.meetingRef) : [];
  const uploaderNames = await resolveDisplayNames(attachmentDocs.map((a) => a.uploadedByUserRef));
  const attachments = attachmentDocs.map((a) => toAttachmentDto(a, uploaderNames.get(a.uploadedByUserRef) ?? null));
  return toMeetingDto(head, version, { owner: { ownerType: head.owner.ownerType, ownerRef: head.owner.ownerRef, ownerDisplayName }, sensitiveVisible, names, attachments });
}

export async function createMeeting(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<NotesMeetingsServiceResult<MeetingDto>> {
  const parsed = createMeetingInputSchema.safeParse(rawInput);
  if (!parsed.success) return notesMeetingsInvalidInputResult(formatIssues(parsed.error));
  const input: CreateMeetingInput = parsed.data;

  const gate = await requireOwnerAccess(actor, input.owner.ownerType, input.owner.ownerRef, "manage_meetings");
  if (!gate.ok) return gate.error;

  const participants = input.participants ?? [];
  for (const p of participants) {
    const check = await requireAdmittedActiveUser(p.userRef);
    if (!check.ok) return notesMeetingsInvalidInputResult(`Participant ${p.userRef} is not an active CreatorOps user.`);
  }

  const now = new Date().toISOString();
  const meetingRef = generateMeetingRef();
  const visibility = input.visibility ?? "STANDARD";
  const version = meetingVersionDocSchema.parse({
    meetingRef,
    version: 1,
    title: input.title,
    meetingAt: input.meetingAt,
    participants,
    agenda: input.agenda ?? null,
    summary: input.summary ?? null,
    decisions: input.decisions ?? [],
    changeKind: "created",
    reason: null,
    createdAt: now,
    createdByUserRef: actor!.userRef,
  });
  const head: MeetingHeadDoc = meetingHeadDocSchema.parse({
    meetingRef,
    docVersion: 1,
    owner: input.owner,
    organizerUserRef: actor!.userRef,
    visibility,
    status: "SCHEDULED",
    latestVersion: 1,
    attachmentRefs: [],
    display: { title: input.title, titleLower: input.title.toLocaleLowerCase(), meetingAt: input.meetingAt, projectedAt: now },
    createdAt: now,
    createdByUserRef: actor!.userRef,
    updatedAt: now,
    updatedByUserRef: actor!.userRef,
  });

  await getAdminFirestore().runTransaction(async (tx) => {
    txCreateMeetingVersion(tx, version);
    txSetMeetingHead(tx, head);
    appendEvent(tx, meetingEventsCollection(meetingRef), {
      kind: "MEETING_CREATED",
      actorUserRef: actor!.userRef,
      metadata: { version: 1, ownerType: input.owner.ownerType, ownerRef: input.owner.ownerRef, visibility, participantCount: participants.length, decisionCount: version.decisions.length },
      requestId,
      createdAt: now,
    });
  });

  // Notifications Completion (spec section 4/21): participant notification, excluding the organizer
  // (the actor who just scheduled it) - projection only, after the transaction above has already
  // committed.
  await notifyMeetingParticipants({
    meetingRef,
    meetingTitle: input.title,
    ownerType: input.owner.ownerType,
    ownerRef: input.owner.ownerRef,
    participantUserRefs: participants.map((p) => p.userRef),
    organizerUserRef: actor!.userRef,
    actorUserRef: actor!.userRef,
    requestId,
  }).catch(() => undefined);

  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);
  return { ok: true, data: await buildMeetingDto(head, version, sensitiveVisible, gate.ownerDisplayName) };
}

export async function getMeeting(actor: ActorContext | null, rawMeetingRef: unknown): Promise<NotesMeetingsServiceResult<MeetingDto>> {
  const loaded = await loadAuthorizedMeeting(actor, typeof rawMeetingRef === "string" ? rawMeetingRef : "");
  if (!loaded.ok) return loaded.error;
  const { head, ownerDisplayName } = loaded.authorized;
  const version = await listMeetingVersionDocs(head.meetingRef, 1).then((page) => page.versions[0] ?? null);
  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);
  return { ok: true, data: await buildMeetingDto(head, version, sensitiveVisible, ownerDisplayName) };
}

export async function listMeetingVersions(actor: ActorContext | null, rawMeetingRef: unknown): Promise<NotesMeetingsServiceResult<{ versions: MeetingVersionDto[] }>> {
  const loaded = await loadAuthorizedMeeting(actor, typeof rawMeetingRef === "string" ? rawMeetingRef : "");
  if (!loaded.ok) return loaded.error;
  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);
  const redacted = loaded.authorized.head.visibility === "RESTRICTED" && !sensitiveVisible;
  const page = await listMeetingVersionDocs(loaded.authorized.head.meetingRef);
  const allRefs = page.versions.flatMap((v) => [v.createdByUserRef, ...v.participants.map((p) => p.userRef)]);
  const names = await resolveDisplayNames(allRefs);
  return { ok: true, data: { versions: page.versions.map((v) => toMeetingVersionDto(v, redacted, names)) } };
}

export async function listMeetingEvents(actor: ActorContext | null, rawMeetingRef: unknown): Promise<NotesMeetingsServiceResult<{ events: NotesMeetingsEventDto[] }>> {
  const loaded = await loadAuthorizedMeeting(actor, typeof rawMeetingRef === "string" ? rawMeetingRef : "");
  if (!loaded.ok) return loaded.error;
  const page = await listMeetingEventDocs(loaded.authorized.head.meetingRef);
  const names = await resolveDisplayNames(page.events.map((e) => e.actorUserRef));
  return { ok: true, data: { events: page.events.map((e) => toEventDto(e, names)) } };
}

export async function reviseMeeting(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<NotesMeetingsServiceResult<MeetingDto>> {
  const parsed = reviseMeetingInputSchema.safeParse(rawInput);
  if (!parsed.success) return notesMeetingsInvalidInputResult(formatIssues(parsed.error));
  const input: ReviseMeetingInput = parsed.data;

  const loaded = await loadAuthorizedMeeting(actor, input.meetingRef, "manage_meetings");
  if (!loaded.ok) return loaded.error;

  if (input.participants) {
    for (const p of input.participants) {
      const check = await requireAdmittedActiveUser(p.userRef);
      if (!check.ok) return notesMeetingsInvalidInputResult(`Participant ${p.userRef} is not an active CreatorOps user.`);
    }
  }

  type Outcome = { kind: "ok"; head: MeetingHeadDoc; version: ReturnType<typeof meetingVersionDocSchema.parse>; material: boolean } | { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string };

  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const head = await txGetMeetingHead(tx, input.meetingRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (head.status === "CANCELLED") return { kind: "conflict", message: "A cancelled meeting cannot be revised." };

    const currentSnapshot = await tx.get(meetingsCollection().doc(input.meetingRef).collection("versions").doc(String(head.latestVersion)));
    const current = meetingVersionDocSchema.parse(currentSnapshot.data());

    const now = new Date().toISOString();
    const nextNumber = head.latestVersion + 1;
    const nextTitle = input.title ?? current.title;
    const nextMeetingAt = input.meetingAt ?? current.meetingAt;
    const nextParticipants = input.participants ?? current.participants;
    const nextAgenda = input.agenda !== undefined ? input.agenda : current.agenda;
    const nextSummary = input.summary !== undefined ? input.summary : current.summary;
    const nextDecisions = input.decisions ?? current.decisions;

    const version = meetingVersionDocSchema.parse({ meetingRef: input.meetingRef, version: nextNumber, title: nextTitle, meetingAt: nextMeetingAt, participants: nextParticipants, agenda: nextAgenda, summary: nextSummary, decisions: nextDecisions, changeKind: "revised", reason: input.reason, createdAt: now, createdByUserRef: actor!.userRef });
    txCreateMeetingVersion(tx, version);

    const nextHead: MeetingHeadDoc = { ...head, docVersion: head.docVersion + 1, latestVersion: nextNumber, display: { title: nextTitle, titleLower: nextTitle.toLocaleLowerCase(), meetingAt: nextMeetingAt, projectedAt: now }, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetMeetingHead(tx, nextHead);

    appendEvent(tx, meetingEventsCollection(input.meetingRef), { kind: "MEETING_REVISED", actorUserRef: actor!.userRef, metadata: { previousVersion: head.latestVersion, newVersion: nextNumber, reason: input.reason, participantCount: nextParticipants.length, decisionCount: nextDecisions.length }, requestId, createdAt: now });

    // Notifications Completion (spec section 4/21): "materially revised" - a judgment call, documented
    // here rather than left implicit - means the title, scheduled time, or participant roster
    // changed; a pure agenda/summary/decisions text edit does not by itself re-notify every
    // participant (avoids noisy duplicates for routine note-taking on an already-known meeting).
    const currentParticipantRefs = new Set(current.participants.map((p) => p.userRef));
    const nextParticipantRefs = new Set(nextParticipants.map((p) => p.userRef));
    const participantsChanged = currentParticipantRefs.size !== nextParticipantRefs.size || [...nextParticipantRefs].some((ref) => !currentParticipantRefs.has(ref));
    const material = nextTitle !== current.title || nextMeetingAt !== current.meetingAt || participantsChanged;

    return { kind: "ok", head: nextHead, version, material };
  });

  if (result.kind === "not_found") return notesMeetingsNotFoundResult();
  if (result.kind === "stale") return notesMeetingsStaleResult();
  if (result.kind === "conflict") return { ok: false, code: "conflict", message: result.message };

  if (result.material) {
    await notifyMeetingRevised({
      meetingRef: result.head.meetingRef,
      meetingTitle: result.version.title,
      ownerType: result.head.owner.ownerType,
      ownerRef: result.head.owner.ownerRef,
      participantUserRefs: result.version.participants.map((p) => p.userRef),
      docVersion: result.head.docVersion,
      actorUserRef: actor!.userRef,
      requestId,
    }).catch(() => undefined);
  }

  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);
  return { ok: true, data: await buildMeetingDto(result.head, result.version, sensitiveVisible, loaded.authorized.ownerDisplayName) };
}

export async function cancelMeeting(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<NotesMeetingsServiceResult<MeetingDto>> {
  const parsed = cancelMeetingInputSchema.safeParse(rawInput);
  if (!parsed.success) return notesMeetingsInvalidInputResult(formatIssues(parsed.error));
  const input: CancelMeetingInput = parsed.data;

  const loaded = await loadAuthorizedMeeting(actor, input.meetingRef, "manage_meetings");
  if (!loaded.ok) return loaded.error;

  type Outcome = { kind: "ok"; head: MeetingHeadDoc } | { kind: "not_found" } | { kind: "stale" } | { kind: "conflict" };
  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const head = await txGetMeetingHead(tx, input.meetingRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (head.status === "CANCELLED") return { kind: "conflict" };
    const now = new Date().toISOString();
    const nextHead: MeetingHeadDoc = { ...head, docVersion: head.docVersion + 1, status: "CANCELLED", cancelledAt: now, cancelledByUserRef: actor!.userRef, cancelledReason: input.reason, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetMeetingHead(tx, nextHead);
    appendEvent(tx, meetingEventsCollection(input.meetingRef), { kind: "MEETING_CANCELLED", actorUserRef: actor!.userRef, metadata: { reason: input.reason }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind === "not_found") return notesMeetingsNotFoundResult();
  if (result.kind === "stale") return notesMeetingsStaleResult();
  if (result.kind === "conflict") return { ok: false, code: "conflict", message: "This meeting is already cancelled." };

  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);
  const version = await listMeetingVersionDocs(result.head.meetingRef, 1).then((page) => page.versions[0] ?? null);
  return { ok: true, data: await buildMeetingDto(result.head, version, sensitiveVisible, loaded.authorized.ownerDisplayName) };
}

export async function listMeetings(actor: ActorContext | null, rawQuery: unknown): Promise<NotesMeetingsServiceResult<{ meetings: MeetingDto[] }>> {
  const parsed = listMeetingsQuerySchema.safeParse(rawQuery);
  if (!parsed.success) return notesMeetingsInvalidInputResult(formatIssues(parsed.error));
  const query: ListMeetingsQuery = parsed.data;

  const gate = await requireOwnerAccess(actor, query.owner.ownerType, query.owner.ownerRef);
  if (!gate.ok) return gate.error;

  const limit = query.limit ?? DEFAULT_MEETING_PAGE_SIZE;
  let firestoreQuery = meetingsCollection().where("owner.ownerType", "==", query.owner.ownerType).where("owner.ownerRef", "==", query.owner.ownerRef) as FirebaseFirestore.Query;
  if (query.status) firestoreQuery = firestoreQuery.where("status", "==", query.status);
  const snapshot = await firestoreQuery.orderBy("createdAt", "desc").limit(limit).get();

  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);
  const heads: MeetingHeadDoc[] = [];
  for (const doc of snapshot.docs) {
    const parsedHead = meetingHeadDocSchema.safeParse(doc.data());
    if (parsedHead.success) heads.push(parsedHead.data);
  }
  const meetings = await Promise.all(
    heads.map(async (head) => {
      const version = await listMeetingVersionDocs(head.meetingRef, 1).then((page) => page.versions[0] ?? null);
      return buildMeetingDto(head, version, sensitiveVisible, gate.ownerDisplayName);
    }),
  );
  return { ok: true, data: { meetings } };
}
