import { randomUUID } from "node:crypto";

import { OWNER_TYPES } from "./owner-registry";
import { txCreateNotesMeetingsEvent } from "./firestore";
import { ACTION_ITEM_STATUSES, MEETING_STATUSES, NOTE_STATUSES, NOTES_MEETINGS_VISIBILITIES, notesMeetingsEventSchema, type NotesMeetingsEvent, type NotesMeetingsEventKind } from "./types";

export type { NotesMeetingsEvent, NotesMeetingsEventKind } from "./types";
export { NOTE_EVENT_KINDS, MEETING_EVENT_KINDS, ACTION_ITEM_EVENT_KINDS, NOTES_MEETINGS_EVENT_KINDS, notesMeetingsEventKindSchema, notesMeetingsEventSchema } from "./types";

// Notes/Meetings Completion (spec section 18): the append-only event trail's metadata allowlist +
// scrubber + builder, shared by Notes/Meetings/MeetingActionItems (each gets its own subcollection -
// see firestore.ts's noteEvents/meetingEvents/actionItemEvents). Mirrors
// src/server/operations/task-events.ts exactly: metadata is passed through an EXPLICIT ALLOWLIST -
// only the named keys below survive, and each only when its VALUE has the expected safe shape. The
// IDENTITY_SHAPED regex bank is a deliberate duplicate of task-events.ts's own bank (every module in
// this repository keeps its own copy - see that file's own comment referencing
// finance-payments/payment-events.ts) so no free-text field beyond a short, identity-shape-scrubbed
// reason is ever representable, and a Note/Meeting's actual RESTRICTED body is never duplicated into
// an event payload regardless (the event never carries `body`/`summary`/`decisions`/`agenda` at all -
// only structural facts). The event SCHEMA itself lives in types.ts (like Task's own taskEventSchema)
// so this file and firestore.ts each import it one-directionally, never from each other.

type ValueCheck = (value: unknown) => boolean;

const isVersionNumber: ValueCheck = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1000;
const oneOf =
  (allowed: readonly string[]): ValueCheck =>
  (value) =>
    typeof value === "string" && allowed.includes(value);
const isOpaqueRef: ValueCheck = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const isIsoTimestamp: ValueCheck = (value) => typeof value === "string" && value.length > 0 && value.length <= 40;
const isBoolean: ValueCheck = (value) => typeof value === "boolean";
const isCount: ValueCheck = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1000;

const IDENTITY_SHAPED: RegExp[] = [
  /\b[A-Z]{5}\d{4}[A-Z]\b/i, // PAN
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/i, // IFSC
  /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/i, // GSTIN
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/, // Aadhaar
  /\d{9,}/, // any long digit run: account numbers, phone numbers, UTRs
  /[^\s@]+@[^\s@]+\.[^\s@]+/, // email address
  /(?:₹|\brs\.?|\binr\b|\busd\b|\$)\s*\d/i, // currency-prefixed amount
];
const isSafeNote: ValueCheck = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 1000 && !IDENTITY_SHAPED.some((pattern) => pattern.test(value));

export const NOTES_MEETINGS_EVENT_METADATA_ALLOWLIST: Readonly<Record<string, ValueCheck>> = {
  version: isVersionNumber,
  previousVersion: isVersionNumber,
  newVersion: isVersionNumber,
  ownerType: oneOf(OWNER_TYPES),
  ownerRef: isOpaqueRef,
  visibility: oneOf(NOTES_MEETINGS_VISIBILITIES),
  status: oneOf([...NOTE_STATUSES, ...MEETING_STATUSES, ...ACTION_ITEM_STATUSES]),
  previousStatus: oneOf([...NOTE_STATUSES, ...MEETING_STATUSES, ...ACTION_ITEM_STATUSES]),
  meetingRef: isOpaqueRef,
  actionItemRef: isOpaqueRef,
  taskRef: isOpaqueRef,
  assigneeUserRef: isOpaqueRef,
  previousAssigneeUserRef: isOpaqueRef,
  dueAt: isIsoTimestamp,
  previousDueAt: isIsoTimestamp,
  participantCount: isCount,
  decisionCount: isCount,
  attachmentRef: isOpaqueRef,
  hasAttachment: isBoolean,
  reason: isSafeNote,
};

export function redactNotesMeetingsEventMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!Object.prototype.hasOwnProperty.call(NOTES_MEETINGS_EVENT_METADATA_ALLOWLIST, key)) continue;
    if (!NOTES_MEETINGS_EVENT_METADATA_ALLOWLIST[key]!(value)) continue;
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

export type NotesMeetingsEventInput = { kind: NotesMeetingsEventKind; actorUserRef: string; metadata: Record<string, unknown> | null; requestId: string; createdAt: string };

export function buildNotesMeetingsEvent(input: NotesMeetingsEventInput): NotesMeetingsEvent {
  return notesMeetingsEventSchema.parse({
    kind: input.kind,
    actorUserRef: input.actorUserRef,
    metadata: redactNotesMeetingsEventMetadata(input.metadata),
    requestId: input.requestId,
    createdAt: input.createdAt,
  });
}

// Builds + redacts the event, then hands it to firestore.ts's txCreateNotesMeetingsEvent to persist -
// this file itself never calls tx.create directly (see notes-meetings-static.test.ts's "only
// firestore.ts writes" guard).
export function appendEvent(tx: FirebaseFirestore.Transaction, collection: FirebaseFirestore.CollectionReference, input: NotesMeetingsEventInput): void {
  txCreateNotesMeetingsEvent(tx, collection, randomUUID(), buildNotesMeetingsEvent(input));
}
