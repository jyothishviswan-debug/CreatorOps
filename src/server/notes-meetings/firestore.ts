import { getAdminFirestore } from "@/server/firebase/admin";

import {
  actionItemHeadDocSchema,
  actionItemVersionDocSchema,
  attachmentMetadataDocSchema,
  meetingHeadDocSchema,
  meetingVersionDocSchema,
  noteHeadDocSchema,
  noteVersionDocSchema,
  notesMeetingsEventSchema,
  type ActionItemHeadDoc,
  type ActionItemVersionDoc,
  type AttachmentMetadataDoc,
  type MeetingHeadDoc,
  type MeetingVersionDoc,
  type NoteHeadDoc,
  type NoteVersionDoc,
  type NotesMeetingsEvent,
} from "./types";

// Notes/Meetings Completion: collection accessors + parse-on-read / parse-on-write helpers. Mirrors
// src/server/operations/firestore.ts's own discipline exactly: no delete anywhere (a Note is
// archived, a Meeting is cancelled, never removed; a version is never rewritten - only
// txCreate*Version exists).

export const NOTES_MEETINGS_COLLECTIONS = {
  notes: "noteEntries",
  noteVersions: "versions",
  noteEvents: "events",
  meetings: "meetings",
  meetingVersions: "versions",
  meetingEvents: "events",
  actionItems: "meetingActionItems", // top-level (queried by meetingRef, never nested - promotion lookups need a flat collection)
  actionItemVersions: "versions",
  actionItemEvents: "events",
  attachments: "notesMeetingsAttachments", // top-level, queried by parentRef
} as const;

export const MAX_VERSION_SUMMARIES = 100;
export const DEFAULT_EVENT_PAGE = 50;
export const MAX_EVENT_PAGE = 100;

function db() {
  return getAdminFirestore();
}

// --- Notes -------------------------------------------------------------------------------------
export function notesCollection() {
  return db().collection(NOTES_MEETINGS_COLLECTIONS.notes);
}
export function noteVersionsCollection(noteRef: string) {
  return notesCollection().doc(noteRef).collection(NOTES_MEETINGS_COLLECTIONS.noteVersions);
}
export function noteEventsCollection(noteRef: string) {
  return notesCollection().doc(noteRef).collection(NOTES_MEETINGS_COLLECTIONS.noteEvents);
}
export function versionDocId(version: number): string {
  return String(version);
}

export async function getNoteHeadDoc(noteRef: string): Promise<NoteHeadDoc | null> {
  const snapshot = await notesCollection().doc(noteRef).get();
  if (!snapshot.exists) return null;
  const result = noteHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getNoteVersionDoc(noteRef: string, version: number): Promise<NoteVersionDoc | null> {
  const snapshot = await noteVersionsCollection(noteRef).doc(versionDocId(version)).get();
  if (!snapshot.exists) return null;
  const result = noteVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function listNoteVersionDocs(noteRef: string, limit = MAX_VERSION_SUMMARIES): Promise<{ versions: NoteVersionDoc[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_VERSION_SUMMARIES));
  const snapshot = await noteVersionsCollection(noteRef)
    .orderBy("version", "desc")
    .limit(bound + 1)
    .get();
  const versions: NoteVersionDoc[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = noteVersionDocSchema.safeParse(doc.data());
    if (parsed.success) versions.push(parsed.data);
  }
  return { versions, hasMore: snapshot.docs.length > bound };
}

export async function listNoteHeadsByOwner(ownerType: string, ownerRef: string, status: string | undefined, limit: number): Promise<NoteHeadDoc[]> {
  let query = notesCollection().where("owner.ownerType", "==", ownerType).where("owner.ownerRef", "==", ownerRef) as FirebaseFirestore.Query;
  if (status) query = query.where("status", "==", status);
  const snapshot = await query.orderBy("createdAt", "desc").limit(limit).get();
  const heads: NoteHeadDoc[] = [];
  for (const doc of snapshot.docs) {
    const parsed = noteHeadDocSchema.safeParse(doc.data());
    if (parsed.success) heads.push(parsed.data);
  }
  return heads;
}

export async function txGetNoteHead(tx: FirebaseFirestore.Transaction, noteRef: string): Promise<NoteHeadDoc | null> {
  const snapshot = await tx.get(notesCollection().doc(noteRef));
  if (!snapshot.exists) return null;
  const result = noteHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}
export function txSetNoteHead(tx: FirebaseFirestore.Transaction, head: NoteHeadDoc): void {
  tx.set(notesCollection().doc(head.noteRef), noteHeadDocSchema.parse(head));
}
export function txCreateNoteVersion(tx: FirebaseFirestore.Transaction, version: NoteVersionDoc): void {
  tx.create(noteVersionsCollection(version.noteRef).doc(versionDocId(version.version)), noteVersionDocSchema.parse(version));
}

// --- Meetings ------------------------------------------------------------------------------------
export function meetingsCollection() {
  return db().collection(NOTES_MEETINGS_COLLECTIONS.meetings);
}
export function meetingVersionsCollection(meetingRef: string) {
  return meetingsCollection().doc(meetingRef).collection(NOTES_MEETINGS_COLLECTIONS.meetingVersions);
}
export function meetingEventsCollection(meetingRef: string) {
  return meetingsCollection().doc(meetingRef).collection(NOTES_MEETINGS_COLLECTIONS.meetingEvents);
}

export async function getMeetingHeadDoc(meetingRef: string): Promise<MeetingHeadDoc | null> {
  const snapshot = await meetingsCollection().doc(meetingRef).get();
  if (!snapshot.exists) return null;
  const result = meetingHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getMeetingVersionDoc(meetingRef: string, version: number): Promise<MeetingVersionDoc | null> {
  const snapshot = await meetingVersionsCollection(meetingRef).doc(versionDocId(version)).get();
  if (!snapshot.exists) return null;
  const result = meetingVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function listMeetingVersionDocs(meetingRef: string, limit = MAX_VERSION_SUMMARIES): Promise<{ versions: MeetingVersionDoc[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_VERSION_SUMMARIES));
  const snapshot = await meetingVersionsCollection(meetingRef)
    .orderBy("version", "desc")
    .limit(bound + 1)
    .get();
  const versions: MeetingVersionDoc[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = meetingVersionDocSchema.safeParse(doc.data());
    if (parsed.success) versions.push(parsed.data);
  }
  return { versions, hasMore: snapshot.docs.length > bound };
}

export async function listMeetingHeadsByOwner(ownerType: string, ownerRef: string, status: string | undefined, limit: number): Promise<MeetingHeadDoc[]> {
  let query = meetingsCollection().where("owner.ownerType", "==", ownerType).where("owner.ownerRef", "==", ownerRef) as FirebaseFirestore.Query;
  if (status) query = query.where("status", "==", status);
  const snapshot = await query.orderBy("createdAt", "desc").limit(limit).get();
  const heads: MeetingHeadDoc[] = [];
  for (const doc of snapshot.docs) {
    const parsed = meetingHeadDocSchema.safeParse(doc.data());
    if (parsed.success) heads.push(parsed.data);
  }
  return heads;
}

export async function txGetMeetingHead(tx: FirebaseFirestore.Transaction, meetingRef: string): Promise<MeetingHeadDoc | null> {
  const snapshot = await tx.get(meetingsCollection().doc(meetingRef));
  if (!snapshot.exists) return null;
  const result = meetingHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}
export function txSetMeetingHead(tx: FirebaseFirestore.Transaction, head: MeetingHeadDoc): void {
  tx.set(meetingsCollection().doc(head.meetingRef), meetingHeadDocSchema.parse(head));
}
export function txCreateMeetingVersion(tx: FirebaseFirestore.Transaction, version: MeetingVersionDoc): void {
  tx.create(meetingVersionsCollection(version.meetingRef).doc(versionDocId(version.version)), meetingVersionDocSchema.parse(version));
}

// --- MeetingActionItems ----------------------------------------------------------------------------
export function actionItemsCollection() {
  return db().collection(NOTES_MEETINGS_COLLECTIONS.actionItems);
}
export function actionItemVersionsCollection(actionItemRef: string) {
  return actionItemsCollection().doc(actionItemRef).collection(NOTES_MEETINGS_COLLECTIONS.actionItemVersions);
}
export function actionItemEventsCollection(actionItemRef: string) {
  return actionItemsCollection().doc(actionItemRef).collection(NOTES_MEETINGS_COLLECTIONS.actionItemEvents);
}

export async function getActionItemHeadDoc(actionItemRef: string): Promise<ActionItemHeadDoc | null> {
  const snapshot = await actionItemsCollection().doc(actionItemRef).get();
  if (!snapshot.exists) return null;
  const result = actionItemHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getActionItemVersionDoc(actionItemRef: string, version: number): Promise<ActionItemVersionDoc | null> {
  const snapshot = await actionItemVersionsCollection(actionItemRef).doc(versionDocId(version)).get();
  if (!snapshot.exists) return null;
  const result = actionItemVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function listActionItemHeadsByMeeting(meetingRef: string, limit = MAX_VERSION_SUMMARIES): Promise<ActionItemHeadDoc[]> {
  const snapshot = await actionItemsCollection().where("meetingRef", "==", meetingRef).orderBy("createdAt", "asc").limit(limit).get();
  const heads: ActionItemHeadDoc[] = [];
  for (const doc of snapshot.docs) {
    const parsed = actionItemHeadDocSchema.safeParse(doc.data());
    if (parsed.success) heads.push(parsed.data);
  }
  return heads;
}

// Reverse lookup (spec section 19: navigable in both directions) - bounded to exactly one match
// since promotedTaskRef is set at most once per action item.
export async function findActionItemByPromotedTask(taskRef: string): Promise<ActionItemHeadDoc | null> {
  const snapshot = await actionItemsCollection().where("promotedTaskRef", "==", taskRef).limit(1).get();
  if (snapshot.empty) return null;
  const parsed = actionItemHeadDocSchema.safeParse(snapshot.docs[0]!.data());
  return parsed.success ? parsed.data : null;
}

export async function txGetActionItemHead(tx: FirebaseFirestore.Transaction, actionItemRef: string): Promise<ActionItemHeadDoc | null> {
  const snapshot = await tx.get(actionItemsCollection().doc(actionItemRef));
  if (!snapshot.exists) return null;
  const result = actionItemHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}
export function txSetActionItemHead(tx: FirebaseFirestore.Transaction, head: ActionItemHeadDoc): void {
  tx.set(actionItemsCollection().doc(head.actionItemRef), actionItemHeadDocSchema.parse(head));
}
export function txCreateActionItemVersion(tx: FirebaseFirestore.Transaction, version: ActionItemVersionDoc): void {
  tx.create(actionItemVersionsCollection(version.actionItemRef).doc(versionDocId(version.version)), actionItemVersionDocSchema.parse(version));
}

// --- Events (shared shape across Notes/Meetings/ActionItems trails) --------------------------------
// The one place any event doc is actually written - notes-meetings-events.ts's appendEvent builds +
// redacts the event, then calls this to persist it, mirroring task-events.ts's own
// buildTaskEvent -> txCreateTaskEvent split exactly (never a raw tx.create outside firestore.ts).
export function txCreateNotesMeetingsEvent(tx: FirebaseFirestore.Transaction, collection: FirebaseFirestore.CollectionReference, eventId: string, event: NotesMeetingsEvent): void {
  tx.create(collection.doc(eventId), notesMeetingsEventSchema.parse(event));
}

async function listEvents(collection: FirebaseFirestore.CollectionReference, limit: number): Promise<{ events: NotesMeetingsEvent[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_EVENT_PAGE));
  const snapshot = await collection
    .orderBy("createdAt", "desc")
    .limit(bound + 1)
    .get();
  const events: NotesMeetingsEvent[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = notesMeetingsEventSchema.safeParse(doc.data());
    if (parsed.success) events.push(parsed.data);
  }
  return { events, hasMore: snapshot.docs.length > bound };
}

export function listNoteEventDocs(noteRef: string, limit = DEFAULT_EVENT_PAGE) {
  return listEvents(noteEventsCollection(noteRef), limit);
}
export function listMeetingEventDocs(meetingRef: string, limit = DEFAULT_EVENT_PAGE) {
  return listEvents(meetingEventsCollection(meetingRef), limit);
}
export function listActionItemEventDocs(actionItemRef: string, limit = DEFAULT_EVENT_PAGE) {
  return listEvents(actionItemEventsCollection(actionItemRef), limit);
}

// --- Attachments -------------------------------------------------------------------------------
export function attachmentsCollection() {
  return db().collection(NOTES_MEETINGS_COLLECTIONS.attachments);
}

export async function getAttachmentMetadataDoc(attachmentRef: string): Promise<AttachmentMetadataDoc | null> {
  const snapshot = await attachmentsCollection().doc(attachmentRef).get();
  if (!snapshot.exists) return null;
  const result = attachmentMetadataDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Bounded (spec section 17: never a whole-collection scan) - a Note/Meeting's own attachmentRefs
// array is itself capped at 20 (types.ts), so this limit is generous headroom, never the real bound.
export const MAX_ATTACHMENTS_PER_PARENT = 50;

export async function listAttachmentMetadataByParent(parentRef: string): Promise<AttachmentMetadataDoc[]> {
  const snapshot = await attachmentsCollection().where("parentRef", "==", parentRef).orderBy("uploadedAt", "asc").limit(MAX_ATTACHMENTS_PER_PARENT).get();
  const docs: AttachmentMetadataDoc[] = [];
  for (const doc of snapshot.docs) {
    const parsed = attachmentMetadataDocSchema.safeParse(doc.data());
    if (parsed.success) docs.push(parsed.data);
  }
  return docs;
}

export function txCreateAttachmentMetadata(tx: FirebaseFirestore.Transaction, doc: AttachmentMetadataDoc): void {
  tx.create(attachmentsCollection().doc(doc.attachmentRef), attachmentMetadataDocSchema.parse(doc));
}

// The ONE place a Note/Meeting head's attachmentRefs array and docVersion/updatedAt/updatedByUserRef
// are touched for an attachment upload - kept here (not as a raw tx.update in attachment-service.ts)
// so every write in this module funnels through firestore.ts, exactly like every other module's own
// discipline (proven by notes-meetings-static.test.ts).
export function txAppendAttachmentToParent(tx: FirebaseFirestore.Transaction, parent: { kind: "NOTE" | "MEETING"; ref: string }, input: { attachmentRef: string; existingAttachmentRefs: string[]; now: string; actorUserRef: string; docVersion: number }): void {
  const collection = parent.kind === "NOTE" ? notesCollection() : meetingsCollection();
  tx.update(collection.doc(parent.ref), { attachmentRefs: [...input.existingAttachmentRefs, input.attachmentRef], docVersion: input.docVersion + 1, updatedAt: input.now, updatedByUserRef: input.actorUserRef });
}
