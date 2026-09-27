import type { NotesMeetingsEvent } from "./notes-meetings-events";
import type { OwnerType } from "./owner-registry";
import type { ActionItemHeadDoc, ActionItemVersionDoc, AttachmentMetadataDoc, MeetingHeadDoc, MeetingVersionDoc, NoteHeadDoc, NoteVersionDoc } from "./types";

// Notes/Meetings Completion (spec section 5/15): pure formatting only - no Firestore, no gate, no
// business module import (mirrors every other module's own "client-dto.ts stays DB-free" boundary,
// proven for Operations by operations-static.test.ts; notes-meetings-static.test.ts proves the same
// here). Sensitivity redaction is a PRECOMPUTED boolean the service layer passes in (exactly like
// Finance Agreement's own `contractDetailVisible` flag in agreement-head-display.ts) - this file only
// ever applies that decision, never makes it.

export type OwnerDto = { ownerType: OwnerType; ownerRef: string; ownerDisplayName: string | null };

export type AttachmentDto = { attachmentRef: string; fileName: string; mimeType: string; sizeBytes: number; uploadedAt: string; uploadedByUserRef: string; uploadedByDisplayName: string | null };

export function toAttachmentDto(doc: AttachmentMetadataDoc, uploaderName: string | null): AttachmentDto {
  return { attachmentRef: doc.attachmentRef, fileName: doc.fileName, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes, uploadedAt: doc.uploadedAt, uploadedByUserRef: doc.uploadedByUserRef, uploadedByDisplayName: uploaderName };
}

// ==================================================================================================
// Notes
// ==================================================================================================
export type NoteDto = {
  noteRef: string;
  docVersion: number;
  owner: OwnerDto;
  visibility: "STANDARD" | "RESTRICTED";
  redacted: boolean;
  status: "ACTIVE" | "ARCHIVED";
  body: string | null;
  latestVersion: number;
  createdAt: string;
  createdByUserRef: string;
  createdByDisplayName: string | null;
  updatedAt: string;
  updatedByUserRef: string;
  updatedByDisplayName: string | null;
  archivedAt: string | null;
  archivedByUserRef: string | null;
  archivedByDisplayName: string | null;
  archivedReason: string | null;
  attachmentCount: number;
  attachments: AttachmentDto[] | null;
};

export type NoteDtoContext = { owner: OwnerDto; sensitiveVisible: boolean; names: Map<string, string | null>; attachments: AttachmentDto[] };

export function toNoteDto(head: NoteHeadDoc, latestVersion: NoteVersionDoc | null, ctx: NoteDtoContext): NoteDto {
  const redacted = head.visibility === "RESTRICTED" && !ctx.sensitiveVisible;
  return {
    noteRef: head.noteRef,
    docVersion: head.docVersion,
    owner: ctx.owner,
    visibility: head.visibility,
    redacted,
    status: head.status,
    body: redacted ? null : (latestVersion?.body ?? null),
    latestVersion: head.latestVersion,
    createdAt: head.createdAt,
    createdByUserRef: head.createdByUserRef,
    createdByDisplayName: ctx.names.get(head.createdByUserRef) ?? null,
    updatedAt: head.updatedAt,
    updatedByUserRef: head.updatedByUserRef,
    updatedByDisplayName: ctx.names.get(head.updatedByUserRef) ?? null,
    archivedAt: head.archivedAt,
    archivedByUserRef: head.archivedByUserRef,
    archivedByDisplayName: head.archivedByUserRef ? (ctx.names.get(head.archivedByUserRef) ?? null) : null,
    archivedReason: head.archivedReason,
    attachmentCount: head.attachmentRefs.length,
    attachments: redacted ? null : ctx.attachments,
  };
}

export type NoteVersionDto = { version: number; body: string | null; changeKind: "created" | "revised"; reason: string | null; createdAt: string; createdByUserRef: string; createdByDisplayName: string | null };

export function toNoteVersionDto(doc: NoteVersionDoc, redacted: boolean, authorName: string | null): NoteVersionDto {
  return { version: doc.version, body: redacted ? null : doc.body, changeKind: doc.changeKind, reason: doc.reason, createdAt: doc.createdAt, createdByUserRef: doc.createdByUserRef, createdByDisplayName: authorName };
}

// ==================================================================================================
// Meetings
// ==================================================================================================
export type ParticipantDto = { userRef: string; displayName: string | null };

export type MeetingDto = {
  meetingRef: string;
  docVersion: number;
  owner: OwnerDto;
  organizerUserRef: string;
  organizerDisplayName: string | null;
  visibility: "STANDARD" | "RESTRICTED";
  redacted: boolean;
  status: "SCHEDULED" | "COMPLETED" | "CANCELLED";
  title: string;
  meetingAt: string;
  participants: ParticipantDto[] | null;
  agenda: string | null;
  summary: string | null;
  decisions: string[] | null;
  latestVersion: number;
  createdAt: string;
  createdByUserRef: string;
  createdByDisplayName: string | null;
  updatedAt: string;
  updatedByUserRef: string;
  updatedByDisplayName: string | null;
  cancelledAt: string | null;
  cancelledByUserRef: string | null;
  cancelledByDisplayName: string | null;
  cancelledReason: string | null;
  attachmentCount: number;
  attachments: AttachmentDto[] | null;
};

export type MeetingDtoContext = { owner: OwnerDto; sensitiveVisible: boolean; names: Map<string, string | null>; attachments: AttachmentDto[] };

export function toMeetingDto(head: MeetingHeadDoc, latestVersion: MeetingVersionDoc | null, ctx: MeetingDtoContext): MeetingDto {
  const redacted = head.visibility === "RESTRICTED" && !ctx.sensitiveVisible;
  return {
    meetingRef: head.meetingRef,
    docVersion: head.docVersion,
    owner: ctx.owner,
    organizerUserRef: head.organizerUserRef,
    organizerDisplayName: ctx.names.get(head.organizerUserRef) ?? null,
    visibility: head.visibility,
    redacted,
    status: head.status,
    title: head.display.title,
    meetingAt: head.display.meetingAt,
    participants: redacted ? null : (latestVersion?.participants.map((p) => ({ userRef: p.userRef, displayName: ctx.names.get(p.userRef) ?? null })) ?? []),
    agenda: redacted ? null : (latestVersion?.agenda ?? null),
    summary: redacted ? null : (latestVersion?.summary ?? null),
    decisions: redacted ? null : (latestVersion?.decisions.map((d) => d.text) ?? []),
    latestVersion: head.latestVersion,
    createdAt: head.createdAt,
    createdByUserRef: head.createdByUserRef,
    createdByDisplayName: ctx.names.get(head.createdByUserRef) ?? null,
    updatedAt: head.updatedAt,
    updatedByUserRef: head.updatedByUserRef,
    updatedByDisplayName: ctx.names.get(head.updatedByUserRef) ?? null,
    cancelledAt: head.cancelledAt,
    cancelledByUserRef: head.cancelledByUserRef,
    cancelledByDisplayName: head.cancelledByUserRef ? (ctx.names.get(head.cancelledByUserRef) ?? null) : null,
    cancelledReason: head.cancelledReason,
    attachmentCount: head.attachmentRefs.length,
    attachments: redacted ? null : ctx.attachments,
  };
}

export type MeetingVersionDto = {
  version: number;
  title: string;
  meetingAt: string;
  participants: ParticipantDto[] | null;
  agenda: string | null;
  summary: string | null;
  decisions: string[] | null;
  changeKind: "created" | "revised";
  reason: string | null;
  createdAt: string;
  createdByUserRef: string;
  createdByDisplayName: string | null;
};

export function toMeetingVersionDto(doc: MeetingVersionDoc, redacted: boolean, names: Map<string, string | null>): MeetingVersionDto {
  return {
    version: doc.version,
    title: doc.title,
    meetingAt: doc.meetingAt,
    participants: redacted ? null : doc.participants.map((p) => ({ userRef: p.userRef, displayName: names.get(p.userRef) ?? null })),
    agenda: redacted ? null : doc.agenda,
    summary: redacted ? null : doc.summary,
    decisions: redacted ? null : doc.decisions.map((d) => d.text),
    changeKind: doc.changeKind,
    reason: doc.reason,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
    createdByDisplayName: names.get(doc.createdByUserRef) ?? null,
  };
}

// ==================================================================================================
// MeetingActionItem
// ==================================================================================================
export type ActionItemDto = {
  actionItemRef: string;
  meetingRef: string;
  docVersion: number;
  status: "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";
  text: string;
  assigneeUserRef: string | null;
  assigneeDisplayName: string | null;
  dueAt: string | null;
  latestVersion: number;
  completedAt: string | null;
  completedByUserRef: string | null;
  completedByDisplayName: string | null;
  cancelledAt: string | null;
  cancelledByUserRef: string | null;
  cancelledByDisplayName: string | null;
  cancelledReason: string | null;
  promotedTaskRef: string | null;
  promotedTaskDisplayName: string | null;
  promotedAt: string | null;
  promotedByUserRef: string | null;
  promotedByDisplayName: string | null;
  linkedReminderRef: string | null;
  createdAt: string;
  createdByUserRef: string;
  createdByDisplayName: string | null;
  updatedAt: string;
  updatedByUserRef: string;
  updatedByDisplayName: string | null;
};

export type ActionItemDtoContext = { names: Map<string, string | null>; promotedTaskDisplayName?: string | null };

export function toActionItemDto(head: ActionItemHeadDoc, ctx: ActionItemDtoContext): ActionItemDto {
  return {
    actionItemRef: head.actionItemRef,
    meetingRef: head.meetingRef,
    docVersion: head.docVersion,
    status: head.status,
    text: head.display.text,
    assigneeUserRef: null, // set by the caller from the latest version (kept off the head schema)
    assigneeDisplayName: null,
    dueAt: head.display.dueAt,
    latestVersion: head.latestVersion,
    completedAt: head.completedAt,
    completedByUserRef: head.completedByUserRef,
    completedByDisplayName: head.completedByUserRef ? (ctx.names.get(head.completedByUserRef) ?? null) : null,
    cancelledAt: head.cancelledAt,
    cancelledByUserRef: head.cancelledByUserRef,
    cancelledByDisplayName: head.cancelledByUserRef ? (ctx.names.get(head.cancelledByUserRef) ?? null) : null,
    cancelledReason: head.cancelledReason,
    promotedTaskRef: head.promotedTaskRef,
    promotedTaskDisplayName: ctx.promotedTaskDisplayName ?? null,
    promotedAt: head.promotedAt,
    promotedByUserRef: head.promotedByUserRef,
    promotedByDisplayName: head.promotedByUserRef ? (ctx.names.get(head.promotedByUserRef) ?? null) : null,
    linkedReminderRef: head.linkedReminderRef,
    createdAt: head.createdAt,
    createdByUserRef: head.createdByUserRef,
    createdByDisplayName: ctx.names.get(head.createdByUserRef) ?? null,
    updatedAt: head.updatedAt,
    updatedByUserRef: head.updatedByUserRef,
    updatedByDisplayName: ctx.names.get(head.updatedByUserRef) ?? null,
  };
}

export function withAssignee(dto: ActionItemDto, assigneeUserRef: string | null, names: Map<string, string | null>): ActionItemDto {
  return { ...dto, assigneeUserRef, assigneeDisplayName: assigneeUserRef ? (names.get(assigneeUserRef) ?? null) : null };
}

export type ActionItemVersionDto = { version: number; text: string; assigneeUserRef: string | null; assigneeDisplayName: string | null; dueAt: string | null; changeKind: "created" | "revised"; reason: string | null; createdAt: string; createdByUserRef: string; createdByDisplayName: string | null };

export function toActionItemVersionDto(doc: ActionItemVersionDoc, names: Map<string, string | null>): ActionItemVersionDto {
  return {
    version: doc.version,
    text: doc.text,
    assigneeUserRef: doc.assigneeUserRef,
    assigneeDisplayName: doc.assigneeUserRef ? (names.get(doc.assigneeUserRef) ?? null) : null,
    dueAt: doc.dueAt,
    changeKind: doc.changeKind,
    reason: doc.reason,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
    createdByDisplayName: names.get(doc.createdByUserRef) ?? null,
  };
}

// ==================================================================================================
// Events
// ==================================================================================================
export type NotesMeetingsEventDto = { kind: string; actorUserRef: string; actorDisplayName: string | null; metadata: Record<string, unknown> | null; createdAt: string };

export function toEventDto(event: NotesMeetingsEvent, names: Map<string, string | null>): NotesMeetingsEventDto {
  return { kind: event.kind, actorUserRef: event.actorUserRef, actorDisplayName: names.get(event.actorUserRef) ?? null, metadata: event.metadata, createdAt: event.createdAt };
}
