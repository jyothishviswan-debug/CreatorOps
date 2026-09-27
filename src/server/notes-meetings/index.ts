// Notes/Meetings Completion: the public service surface. Routes import from here; internals
// (Firestore helpers, the gate, the event redactors) stay module-private. Mirrors every other
// module's own index.ts barrel shape (see src/server/operations/index.ts).
export { archiveNote, createNote, getNote, listNoteEvents, listNotes, listNoteVersions, reviseNote } from "./note-service";
export { cancelMeeting, createMeeting, getMeeting, listMeetingEvents, listMeetings, listMeetingVersions, reviseMeeting } from "./meeting-service";
export { cancelActionItem, completeActionItem, createActionItem, getActionItem, listActionItemEvents, listActionItems, listActionItemVersions, reviseActionItem } from "./action-item-service";
export { findMeetingActionItemByTask, promoteActionItem } from "./promotion";
export { addAttachment, getAttachmentBytes, listAttachments, type AttachmentParent } from "./attachment-service";
export { readAttachmentUploadRequest } from "./attachment-upload-request";
export { searchActiveUsersForNotesMeetings, type NotesMeetingsUserOption } from "./user-search";
export { OWNER_TYPE_REGISTRY, OWNER_TYPES, isSupportedOwnerType, type OwnerType, type OwnerTypeClassification } from "./owner-registry";
export { computeNotesMeetingsUiPermissions, type NotesMeetingsUiPermissions } from "./ui-permissions";
export type { ActionItemDto, AttachmentDto, MeetingDto, MeetingVersionDto, NoteDto, NoteVersionDto, NotesMeetingsEventDto, OwnerDto } from "./client-dto";
export type { NotesMeetingsServiceResult } from "./types";
export { NOTES_MEETINGS_SENSITIVE_CATEGORY, NOTES_MEETINGS_VISIBILITIES, ACTION_ITEM_STATUSES, MEETING_STATUSES, NOTE_STATUSES } from "./types";
export type { ActionItemStatus, MeetingStatus, NoteStatus, NotesMeetingsVisibility } from "./types";
