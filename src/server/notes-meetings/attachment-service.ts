import { createHash } from "node:crypto";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { getAttachmentStore } from "./attachment-store";
import { toAttachmentDto, type AttachmentDto } from "./client-dto";
import { resolveDisplayName, resolveDisplayNames } from "./display-names";
import { getAttachmentMetadataDoc, listAttachmentMetadataByParent, meetingEventsCollection, meetingsCollection, noteEventsCollection, notesCollection, txAppendAttachmentToParent, txCreateAttachmentMetadata } from "./firestore";
import { generateAttachmentRef } from "./ids";
import { appendEvent } from "./notes-meetings-events";
import { canViewSensitiveNotesMeetings, loadAuthorizedMeeting, loadAuthorizedNote } from "./notes-meetings-gate";
import { ALLOWED_ATTACHMENT_MIME_TYPES, attachmentMetadataDocSchema, MAX_ATTACHMENT_BYTES, notesMeetingsConflictResult, notesMeetingsInvalidInputResult, notesMeetingsNotFoundResult, type NotesMeetingsServiceResult } from "./types";

const MAX_ATTACHMENT_REFS_PER_PARENT = 20; // mirrors types.ts's own noteHeadDocSchema/meetingHeadDocSchema attachmentRefs.max(20)

// Notes/Meetings Completion (spec section 13): attachment upload/list/download. Every read/write
// re-authorizes through the SAME owner-composition gate a Note/Meeting itself uses (loadAuthorizedNote/
// loadAuthorizedMeeting) - an attachment carries no authorization of its own, and RESTRICTED
// visibility hides an attachment's very existence from an actor lacking the sensitive category
// (never just its bytes) exactly like the Note/Meeting body itself.

export type AttachmentParent = { kind: "NOTE"; ref: string } | { kind: "MEETING"; ref: string };

function safeFileName(raw: string): string {
  const base = raw.replace(/[\\/]/g, "_").replace(/[^\w.\- ]/g, "_").trim();
  return (base.length > 0 ? base : "attachment").slice(0, 200);
}

async function loadAuthorizedParent(actor: ActorContext | null, parent: AttachmentParent) {
  if (parent.kind === "NOTE") {
    const loaded = await loadAuthorizedNote(actor, parent.ref, "manage_notes");
    if (!loaded.ok) return { ok: false as const, error: loaded.error };
    return { ok: true as const, visibility: loaded.authorized.head.visibility, docVersion: loaded.authorized.head.docVersion, attachmentRefs: loaded.authorized.head.attachmentRefs };
  }
  const loaded = await loadAuthorizedMeeting(actor, parent.ref, "manage_meetings");
  if (!loaded.ok) return { ok: false as const, error: loaded.error };
  return { ok: true as const, visibility: loaded.authorized.head.visibility, docVersion: loaded.authorized.head.docVersion, attachmentRefs: loaded.authorized.head.attachmentRefs };
}

export type AddAttachmentInput = { parent: AttachmentParent; fileName: string; mimeType: string; bytes: Uint8Array };

export async function addAttachment(actor: ActorContext | null, input: AddAttachmentInput, requestId: string): Promise<NotesMeetingsServiceResult<AttachmentDto>> {
  const parentGate = await loadAuthorizedParent(actor, input.parent);
  if (!parentGate.ok) return parentGate.error;
  if (parentGate.attachmentRefs.length >= MAX_ATTACHMENT_REFS_PER_PARENT) return notesMeetingsConflictResult(`This record already has the maximum of ${MAX_ATTACHMENT_REFS_PER_PARENT} attachments.`);

  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_ATTACHMENT_BYTES) return notesMeetingsInvalidInputResult(`The attachment must be between 1 byte and ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`);
  if (!(ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(input.mimeType)) return notesMeetingsInvalidInputResult("This file type is not allowed as an attachment.");

  const attachmentRef = generateAttachmentRef();
  const fileName = safeFileName(input.fileName);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");

  const locator = await getAttachmentStore().put({ attachmentRef, bytes: input.bytes, mimeType: input.mimeType });

  const now = new Date().toISOString();
  const doc = attachmentMetadataDocSchema.parse({ attachmentRef, ownerKind: input.parent.kind, parentRef: input.parent.ref, fileName, mimeType: input.mimeType, sizeBytes: input.bytes.byteLength, sha256, locator, uploadedAt: now, uploadedByUserRef: actor!.userRef });

  const parentCollection = input.parent.kind === "NOTE" ? notesCollection() : meetingsCollection();
  const eventsCollection = input.parent.kind === "NOTE" ? noteEventsCollection(input.parent.ref) : meetingEventsCollection(input.parent.ref);
  const eventKind = input.parent.kind === "NOTE" ? ("NOTE_ATTACHMENT_ADDED" as const) : ("MEETING_ATTACHMENT_ADDED" as const);

  type Outcome = { kind: "ok" } | { kind: "not_found" } | { kind: "conflict"; message: string };
  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const parentSnapshot = await tx.get(parentCollection.doc(input.parent.ref));
    if (!parentSnapshot.exists) return { kind: "not_found" };
    const parentData = parentSnapshot.data() as { attachmentRefs?: string[]; docVersion: number };
    const currentRefs = parentData.attachmentRefs ?? [];
    if (currentRefs.length >= MAX_ATTACHMENT_REFS_PER_PARENT) return { kind: "conflict", message: `This record already has the maximum of ${MAX_ATTACHMENT_REFS_PER_PARENT} attachments.` };

    txCreateAttachmentMetadata(tx, doc);
    txAppendAttachmentToParent(tx, input.parent, { attachmentRef, existingAttachmentRefs: currentRefs, now, actorUserRef: actor!.userRef, docVersion: parentData.docVersion });
    appendEvent(tx, eventsCollection, { kind: eventKind, actorUserRef: actor!.userRef, metadata: { attachmentRef, hasAttachment: true }, requestId, createdAt: now });
    return { kind: "ok" };
  });

  if (result.kind === "not_found") return notesMeetingsNotFoundResult();
  if (result.kind === "conflict") return notesMeetingsConflictResult(result.message);

  const uploaderName = await resolveDisplayName(actor!.userRef);
  return { ok: true, data: toAttachmentDto(doc, uploaderName) };
}

export async function listAttachments(actor: ActorContext | null, parent: AttachmentParent): Promise<NotesMeetingsServiceResult<{ attachments: AttachmentDto[] }>> {
  const parentGate = await loadAuthorizedParent(actor, parent);
  if (!parentGate.ok) return parentGate.error;

  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);
  if (parentGate.visibility === "RESTRICTED" && !sensitiveVisible) return { ok: true, data: { attachments: [] } };

  const docs = await listAttachmentMetadataByParent(parent.ref);
  const names = await resolveDisplayNames(docs.map((d) => d.uploadedByUserRef));
  return { ok: true, data: { attachments: docs.map((d) => toAttachmentDto(d, names.get(d.uploadedByUserRef) ?? null)) } };
}

export type AttachmentDownload = { fileName: string; mimeType: string; bytes: Uint8Array };
export type DownloadAttachmentResult = { ok: true; data: AttachmentDownload } | { ok: false; error: ReturnType<typeof notesMeetingsNotFoundResult> };

export async function getAttachmentBytes(actor: ActorContext | null, attachmentRef: string): Promise<DownloadAttachmentResult> {
  const meta = await getAttachmentMetadataDoc(attachmentRef);
  if (!meta) return { ok: false, error: notesMeetingsNotFoundResult() };

  const parent: AttachmentParent = meta.ownerKind === "NOTE" ? { kind: "NOTE", ref: meta.parentRef } : { kind: "MEETING", ref: meta.parentRef };
  const parentGate = await loadAuthorizedParent(actor, parent);
  if (!parentGate.ok) return { ok: false, error: notesMeetingsNotFoundResult() };

  const sensitiveVisible = await canViewSensitiveNotesMeetings(actor!);
  if (parentGate.visibility === "RESTRICTED" && !sensitiveVisible) return { ok: false, error: notesMeetingsNotFoundResult() };

  const bytes = await getAttachmentStore().get(meta.locator);
  return { ok: true, data: { fileName: meta.fileName, mimeType: meta.mimeType, bytes } };
}
