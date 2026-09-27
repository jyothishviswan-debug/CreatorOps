import { z } from "zod";

import { ownerReferenceSchema } from "./owner-registry";

// Notes/Meetings Completion: the canonical NoteEntry / Meeting / MeetingActionItem domain.
//
// Shapes follow the SAME head/version/event discipline every other module in this repository already
// established (src/server/operations/types.ts's Task is the closest structural analog, per the
// reconnaissance): one HEAD carrying only current workflow/indexable projection fields, an
// append-only chain of numbered, IMMUTABLE VERSIONS carrying the declared content, and an
// append-only event history (notes-meetings-events.ts). Deliberately the SAME level of complexity as
// Task/Reminder - never Finance Agreement's fuller DRAFT/ACTIVE/SUPERSEDED lifecycle (spec: "keep the
// lifecycle minimal").
//
// Hard rule encoded here (spec section 19): a MeetingActionItem is never itself an OperationsTask. It
// carries only a `promotedTaskRef` BACK-REFERENCE, set exactly once, by an explicit promotion action
// (promotion.ts) - never a mirrored copy of Task's own lifecycle fields.

const isoTimestamp = z.string().min(1);
const nonEmpty = z.string().min(1);
const refString = z.string().min(1).max(200);
const shortText = (max: number) => z.string().trim().min(1).max(max);

// ==================================================================================================
// Visibility / sensitivity (spec section 5)
// ==================================================================================================
export const NOTES_MEETINGS_VISIBILITIES = ["STANDARD", "RESTRICTED"] as const;
export const notesMeetingsVisibilitySchema = z.enum(NOTES_MEETINGS_VISIBILITIES);
export type NotesMeetingsVisibility = z.infer<typeof notesMeetingsVisibilitySchema>;

// The one sensitive-access category this module gates on (see sensitive-categories.ts). Kept as a
// literal (not a free string) so a RESTRICTED doc can never name an unrelated category by mistake.
export const NOTES_MEETINGS_SENSITIVE_CATEGORY = "notes_meetings_sensitive" as const;

// ==================================================================================================
// NoteEntry
// ==================================================================================================
export const MAX_NOTE_VERSIONS = 500;
export const NOTE_VERSION_CHANGE_KINDS = ["created", "revised"] as const;
export const noteVersionChangeKindSchema = z.enum(NOTE_VERSION_CHANGE_KINDS);

export const noteVersionDocSchema = z
  .object({
    noteRef: nonEmpty,
    version: z.number().int().min(1).max(MAX_NOTE_VERSIONS),
    body: shortText(4000),
    changeKind: noteVersionChangeKindSchema,
    reason: shortText(1000).nullable(),
    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (doc.version === 1 && doc.changeKind !== "created") ctx.addIssue({ code: "custom", path: ["changeKind"], message: "Version 1 is the creation." });
    if (doc.version > 1 && doc.changeKind === "created") ctx.addIssue({ code: "custom", path: ["changeKind"], message: "Only version 1 is the creation." });
  });
export type NoteVersionDoc = z.infer<typeof noteVersionDocSchema>;

export const NOTE_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export const noteStatusSchema = z.enum(NOTE_STATUSES);
export type NoteStatus = z.infer<typeof noteStatusSchema>;

export const noteHeadDisplaySchema = z.object({ bodyPreview: shortText(200), projectedAt: isoTimestamp }).strict();

export const noteHeadDocSchema = z
  .object({
    noteRef: nonEmpty,
    docVersion: z.number().int().min(1),
    owner: ownerReferenceSchema,
    visibility: notesMeetingsVisibilitySchema,
    latestVersion: z.number().int().min(1).max(MAX_NOTE_VERSIONS),
    status: noteStatusSchema,
    archivedAt: isoTimestamp.nullable().default(null),
    archivedByUserRef: nonEmpty.nullable().default(null),
    archivedReason: shortText(1000).nullable().default(null),
    attachmentRefs: z.array(nonEmpty).max(20).default([]),
    display: noteHeadDisplaySchema,
    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
    updatedAt: isoTimestamp,
    updatedByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((head, ctx) => {
    if (head.status === "ARCHIVED" && (head.archivedAt === null || head.archivedByUserRef === null)) ctx.addIssue({ code: "custom", path: ["archivedAt"], message: "An archived note records when and by whom." });
    if (head.status === "ACTIVE" && (head.archivedAt !== null || head.archivedByUserRef !== null)) ctx.addIssue({ code: "custom", path: ["status"], message: "An active note carries no archive metadata." });
  });
export type NoteHeadDoc = z.infer<typeof noteHeadDocSchema>;

export const noteRefSchema = z.string().regex(/^note_[0-9a-f]{20}$/, "Invalid note reference.");
const expectedDocVersionSchema = z.number().int().min(1);
const reasonSchema = z.string().trim().min(3).max(1000);

export const createNoteInputSchema = z
  .object({
    owner: ownerReferenceSchema,
    body: shortText(4000),
    visibility: notesMeetingsVisibilitySchema.optional(),
  })
  .strict();
export type CreateNoteInput = z.infer<typeof createNoteInputSchema>;

export const reviseNoteInputSchema = z
  .object({
    noteRef: noteRefSchema,
    expectedDocVersion: expectedDocVersionSchema,
    body: shortText(4000),
    reason: reasonSchema,
  })
  .strict();
export type ReviseNoteInput = z.infer<typeof reviseNoteInputSchema>;

export const archiveNoteInputSchema = z.object({ noteRef: noteRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type ArchiveNoteInput = z.infer<typeof archiveNoteInputSchema>;

export const MAX_NOTE_PAGE_SIZE = 100;
export const DEFAULT_NOTE_PAGE_SIZE = 25;

export const listNotesQuerySchema = z
  .object({
    owner: ownerReferenceSchema,
    status: noteStatusSchema.optional(),
    authorUserRef: nonEmpty.optional(),
    limit: z.number().int().min(1).max(MAX_NOTE_PAGE_SIZE).optional(),
  })
  .strict();
export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;

// ==================================================================================================
// Meeting / MoM
// ==================================================================================================
export const MAX_MEETING_VERSIONS = 500;
export const MEETING_VERSION_CHANGE_KINDS = ["created", "revised"] as const;
export const meetingVersionChangeKindSchema = z.enum(MEETING_VERSION_CHANGE_KINDS);

export const MAX_PARTICIPANTS = 30;
export const MAX_DECISIONS = 30;

export const meetingParticipantSchema = z.object({ userRef: nonEmpty }).strict();
export const meetingDecisionSchema = z.object({ text: shortText(2000) }).strict();

export const meetingVersionDocSchema = z
  .object({
    meetingRef: nonEmpty,
    version: z.number().int().min(1).max(MAX_MEETING_VERSIONS),
    title: shortText(200),
    meetingAt: isoTimestamp,
    participants: z.array(meetingParticipantSchema).max(MAX_PARTICIPANTS),
    agenda: shortText(4000).nullable(),
    summary: shortText(8000).nullable(),
    decisions: z.array(meetingDecisionSchema).max(MAX_DECISIONS),
    changeKind: meetingVersionChangeKindSchema,
    reason: shortText(1000).nullable(),
    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (doc.version === 1 && doc.changeKind !== "created") ctx.addIssue({ code: "custom", path: ["changeKind"], message: "Version 1 is the creation." });
    if (doc.version > 1 && doc.changeKind === "created") ctx.addIssue({ code: "custom", path: ["changeKind"], message: "Only version 1 is the creation." });
  });
export type MeetingVersionDoc = z.infer<typeof meetingVersionDocSchema>;

export const MEETING_STATUSES = ["SCHEDULED", "COMPLETED", "CANCELLED"] as const;
export const meetingStatusSchema = z.enum(MEETING_STATUSES);
export type MeetingStatus = z.infer<typeof meetingStatusSchema>;

export const meetingHeadDisplaySchema = z.object({ title: shortText(200), titleLower: shortText(200), meetingAt: isoTimestamp, projectedAt: isoTimestamp }).strict();

export const meetingHeadDocSchema = z
  .object({
    meetingRef: nonEmpty,
    docVersion: z.number().int().min(1),
    owner: ownerReferenceSchema,
    organizerUserRef: nonEmpty,
    visibility: notesMeetingsVisibilitySchema,
    status: meetingStatusSchema,
    latestVersion: z.number().int().min(1).max(MAX_MEETING_VERSIONS),
    cancelledAt: isoTimestamp.nullable().default(null),
    cancelledByUserRef: nonEmpty.nullable().default(null),
    cancelledReason: shortText(1000).nullable().default(null),
    attachmentRefs: z.array(nonEmpty).max(20).default([]),
    display: meetingHeadDisplaySchema,
    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
    updatedAt: isoTimestamp,
    updatedByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((head, ctx) => {
    if (head.status === "CANCELLED" && (head.cancelledAt === null || head.cancelledByUserRef === null || head.cancelledReason === null)) ctx.addIssue({ code: "custom", path: ["cancelledReason"], message: "A cancelled meeting records when, by whom and why." });
    if (head.status !== "CANCELLED" && head.cancelledAt !== null) ctx.addIssue({ code: "custom", path: ["status"], message: "Only a cancelled meeting carries cancellation metadata." });
  });
export type MeetingHeadDoc = z.infer<typeof meetingHeadDocSchema>;

export const meetingRefSchema = z.string().regex(/^mtg_[0-9a-f]{20}$/, "Invalid meeting reference.");

export const createMeetingInputSchema = z
  .object({
    owner: ownerReferenceSchema,
    title: shortText(200),
    meetingAt: isoTimestamp,
    participants: z.array(meetingParticipantSchema).max(MAX_PARTICIPANTS).optional(),
    agenda: shortText(4000).nullable().optional(),
    summary: shortText(8000).nullable().optional(),
    decisions: z.array(meetingDecisionSchema).max(MAX_DECISIONS).optional(),
    visibility: notesMeetingsVisibilitySchema.optional(),
  })
  .strict();
export type CreateMeetingInput = z.infer<typeof createMeetingInputSchema>;

export const reviseMeetingInputSchema = z
  .object({
    meetingRef: meetingRefSchema,
    expectedDocVersion: expectedDocVersionSchema,
    title: shortText(200).optional(),
    meetingAt: isoTimestamp.optional(),
    participants: z.array(meetingParticipantSchema).max(MAX_PARTICIPANTS).optional(),
    agenda: shortText(4000).nullable().optional(),
    summary: shortText(8000).nullable().optional(),
    decisions: z.array(meetingDecisionSchema).max(MAX_DECISIONS).optional(),
    reason: reasonSchema,
  })
  .strict();
export type ReviseMeetingInput = z.infer<typeof reviseMeetingInputSchema>;

export const cancelMeetingInputSchema = z.object({ meetingRef: meetingRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type CancelMeetingInput = z.infer<typeof cancelMeetingInputSchema>;

export const MAX_MEETING_PAGE_SIZE = 100;
export const DEFAULT_MEETING_PAGE_SIZE = 25;

export const listMeetingsQuerySchema = z
  .object({
    owner: ownerReferenceSchema,
    status: meetingStatusSchema.optional(),
    limit: z.number().int().min(1).max(MAX_MEETING_PAGE_SIZE).optional(),
  })
  .strict();
export type ListMeetingsQuery = z.infer<typeof listMeetingsQuerySchema>;

// ==================================================================================================
// MeetingActionItem
// ==================================================================================================
export const ACTION_ITEM_STATUSES = ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"] as const;
export const actionItemStatusSchema = z.enum(ACTION_ITEM_STATUSES);
export type ActionItemStatus = z.infer<typeof actionItemStatusSchema>;

export const MAX_ACTION_ITEM_VERSIONS = 200;
export const ACTION_ITEM_VERSION_CHANGE_KINDS = ["created", "revised"] as const;
export const actionItemVersionChangeKindSchema = z.enum(ACTION_ITEM_VERSION_CHANGE_KINDS);

export const actionItemVersionDocSchema = z
  .object({
    actionItemRef: nonEmpty,
    version: z.number().int().min(1).max(MAX_ACTION_ITEM_VERSIONS),
    text: shortText(1000),
    assigneeUserRef: nonEmpty.nullable(),
    dueAt: isoTimestamp.nullable(),
    changeKind: actionItemVersionChangeKindSchema,
    reason: shortText(1000).nullable(),
    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
  })
  .strict();
export type ActionItemVersionDoc = z.infer<typeof actionItemVersionDocSchema>;

export const actionItemHeadDisplaySchema = z.object({ text: shortText(1000), status: actionItemStatusSchema, dueAt: isoTimestamp.nullable(), projectedAt: isoTimestamp }).strict();

export const actionItemHeadDocSchema = z
  .object({
    actionItemRef: nonEmpty,
    meetingRef: nonEmpty,
    docVersion: z.number().int().min(1),
    status: actionItemStatusSchema,
    latestVersion: z.number().int().min(1).max(MAX_ACTION_ITEM_VERSIONS),
    completedAt: isoTimestamp.nullable().default(null),
    completedByUserRef: nonEmpty.nullable().default(null),
    cancelledAt: isoTimestamp.nullable().default(null),
    cancelledByUserRef: nonEmpty.nullable().default(null),
    cancelledReason: shortText(1000).nullable().default(null),
    // Promotion/link status (spec section 2C/9/19). Set exactly once, transactionally, by
    // promotion.ts - never rewritten, never cleared. This is the actual idempotency guard AND the
    // durable Meeting -> Task back-reference (the forward Task -> Meeting direction is recoverable
    // from the Task's own deterministic `sourceKey`, which literally embeds this actionItemRef - see
    // promotion.ts's own comment on why a second, weaker idempotency mechanism was not built).
    promotedTaskRef: nonEmpty.nullable().default(null),
    promotedAt: isoTimestamp.nullable().default(null),
    promotedByUserRef: nonEmpty.nullable().default(null),
    // Reserved for a later stage (spec section 10/20) - always null this stage. See promotion.ts's
    // header comment for why linked-Reminder was deliberately deferred.
    linkedReminderRef: nonEmpty.nullable().default(null),
    display: actionItemHeadDisplaySchema,
    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
    updatedAt: isoTimestamp,
    updatedByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((head, ctx) => {
    if (head.status === "DONE" && (head.completedAt === null || head.completedByUserRef === null)) ctx.addIssue({ code: "custom", path: ["completedAt"], message: "A done action item records when and by whom." });
    if (head.status === "CANCELLED" && (head.cancelledAt === null || head.cancelledByUserRef === null || head.cancelledReason === null)) ctx.addIssue({ code: "custom", path: ["cancelledReason"], message: "A cancelled action item records when, by whom and why." });
    if ((head.promotedTaskRef === null) !== (head.promotedAt === null) || (head.promotedTaskRef === null) !== (head.promotedByUserRef === null)) {
      ctx.addIssue({ code: "custom", path: ["promotedTaskRef"], message: "Promotion fields are set together or not at all." });
    }
  });
export type ActionItemHeadDoc = z.infer<typeof actionItemHeadDocSchema>;

export const actionItemRefSchema = z.string().regex(/^mai_[0-9a-f]{20}$/, "Invalid action item reference.");

export const createActionItemInputSchema = z
  .object({
    meetingRef: meetingRefSchema,
    expectedDocVersion: expectedDocVersionSchema,
    text: shortText(1000),
    assigneeUserRef: nonEmpty.nullable().optional(),
    dueAt: isoTimestamp.nullable().optional(),
  })
  .strict();
export type CreateActionItemInput = z.infer<typeof createActionItemInputSchema>;

export const reviseActionItemInputSchema = z
  .object({
    actionItemRef: actionItemRefSchema,
    expectedDocVersion: expectedDocVersionSchema,
    text: shortText(1000).optional(),
    assigneeUserRef: nonEmpty.nullable().optional(),
    dueAt: isoTimestamp.nullable().optional(),
    status: z.enum(["OPEN", "IN_PROGRESS"]).optional(),
    reason: reasonSchema,
  })
  .strict();
export type ReviseActionItemInput = z.infer<typeof reviseActionItemInputSchema>;

export const completeActionItemInputSchema = z.object({ actionItemRef: actionItemRefSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type CompleteActionItemInput = z.infer<typeof completeActionItemInputSchema>;

export const cancelActionItemInputSchema = z.object({ actionItemRef: actionItemRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type CancelActionItemInput = z.infer<typeof cancelActionItemInputSchema>;

export const promoteActionItemInputSchema = z
  .object({
    actionItemRef: actionItemRefSchema,
    // The assignee for the created Task - defaults to the action item's own assignee when present
    // and an admitted active user; required otherwise (the promoting actor must pick one).
    assigneeUserRef: nonEmpty.optional(),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
  })
  .strict();
export type PromoteActionItemInput = z.infer<typeof promoteActionItemInputSchema>;

// ==================================================================================================
// Attachments (spec section 13)
// ==================================================================================================
export const ATTACHMENT_OWNER_KINDS = ["NOTE", "MEETING"] as const;
export const attachmentOwnerKindSchema = z.enum(ATTACHMENT_OWNER_KINDS);
export type AttachmentOwnerKind = z.infer<typeof attachmentOwnerKindSchema>;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB, matches Import Center's own file cap.
export const ALLOWED_ATTACHMENT_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg", "text/plain", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] as const;

export const attachmentMetadataDocSchema = z
  .object({
    attachmentRef: nonEmpty,
    ownerKind: attachmentOwnerKindSchema,
    // noteRef or meetingRef, matching ownerKind.
    parentRef: nonEmpty,
    fileName: shortText(200),
    mimeType: nonEmpty,
    sizeBytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    // The opaque, server-only Storage locator (see attachment-store.ts). Never sent to the client.
    locator: nonEmpty,
    uploadedAt: isoTimestamp,
    uploadedByUserRef: nonEmpty,
  })
  .strict();
export type AttachmentMetadataDoc = z.infer<typeof attachmentMetadataDocSchema>;

// ==================================================================================================
// Result/error plumbing - same shape family as every other module's own (Operations/Finance)
// ==================================================================================================
export type NotesMeetingsDenialReason = "not_authenticated" | "owner_denied" | "feature_denied" | "action_denied" | "sensitive_denied";
export type NotesMeetingsServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "conflict" | "internal";

export type NotesMeetingsServiceResult<T> = { ok: true; data: T } | { ok: false; code: NotesMeetingsServiceErrorCode; message: string; reason?: NotesMeetingsDenialReason };
export type NotesMeetingsErrorResult = Extract<NotesMeetingsServiceResult<unknown>, { ok: false }>;

export function notesMeetingsUnauthorizedResult(reason: NotesMeetingsDenialReason): NotesMeetingsErrorResult {
  return { ok: false, code: "unauthorized", message: "Notes/Meetings access denied.", reason };
}
export function notesMeetingsInvalidInputResult(message: string): NotesMeetingsErrorResult {
  return { ok: false, code: "invalid_input", message };
}
export const NEUTRAL_NOT_FOUND_MESSAGE = "Not found.";
export function notesMeetingsNotFoundResult(message: string = NEUTRAL_NOT_FOUND_MESSAGE): NotesMeetingsErrorResult {
  return { ok: false, code: "not_found", message };
}
export function notesMeetingsStaleResult(message = "This record was changed elsewhere. Reload and try again."): NotesMeetingsErrorResult {
  return { ok: false, code: "stale_write", message };
}
export function notesMeetingsConflictResult(message: string): NotesMeetingsErrorResult {
  return { ok: false, code: "conflict", message };
}
export function notesMeetingsInvalidResult(message: string): NotesMeetingsErrorResult {
  return { ok: false, code: "invalid_input", message };
}

// ==================================================================================================
// Events (spec section 18) - the schema/kind catalog lives here (not in notes-meetings-events.ts),
// exactly mirroring src/server/operations/types.ts's own taskEventSchema placement, so firestore.ts
// and notes-meetings-events.ts each import it from types.ts one-directionally - never from each
// other (avoids the circular-import shape a shared events.ts would otherwise create).
export const NOTE_EVENT_KINDS = ["NOTE_CREATED", "NOTE_REVISED", "NOTE_ARCHIVED", "NOTE_ATTACHMENT_ADDED"] as const;
export const MEETING_EVENT_KINDS = ["MEETING_CREATED", "MEETING_REVISED", "MEETING_CANCELLED", "MEETING_ATTACHMENT_ADDED"] as const;
export const ACTION_ITEM_EVENT_KINDS = ["ACTION_ITEM_CREATED", "ACTION_ITEM_REVISED", "ACTION_ITEM_COMPLETED", "ACTION_ITEM_CANCELLED", "ACTION_ITEM_PROMOTED"] as const;

export const NOTES_MEETINGS_EVENT_KINDS = [...NOTE_EVENT_KINDS, ...MEETING_EVENT_KINDS, ...ACTION_ITEM_EVENT_KINDS] as const;
export const notesMeetingsEventKindSchema = z.enum(NOTES_MEETINGS_EVENT_KINDS);
export type NotesMeetingsEventKind = z.infer<typeof notesMeetingsEventKindSchema>;

export const notesMeetingsEventSchema = z
  .object({
    kind: notesMeetingsEventKindSchema,
    actorUserRef: nonEmpty,
    metadata: z.record(z.string(), z.unknown()).nullable(),
    requestId: nonEmpty,
    createdAt: isoTimestamp,
  })
  .strict();
export type NotesMeetingsEvent = z.infer<typeof notesMeetingsEventSchema>;

export { refString, shortText };
