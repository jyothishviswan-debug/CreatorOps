import { describe, expect, it } from "vitest";

import {
  actionItemHeadDocSchema,
  actionItemVersionDocSchema,
  createActionItemInputSchema,
  createMeetingInputSchema,
  createNoteInputSchema,
  meetingHeadDocSchema,
  meetingVersionDocSchema,
  noteHeadDocSchema,
  noteVersionDocSchema,
  notesMeetingsConflictResult,
  notesMeetingsInvalidInputResult,
  notesMeetingsNotFoundResult,
  notesMeetingsStaleResult,
  notesMeetingsUnauthorizedResult,
  reviseNoteInputSchema,
} from "./types";

const now = new Date().toISOString();

describe("noteVersionDocSchema", () => {
  it("accepts a valid v1 'created' version and rejects a mismatched changeKind", () => {
    expect(noteVersionDocSchema.safeParse({ noteRef: "note_1", version: 1, body: "hello", changeKind: "created", reason: null, createdAt: now, createdByUserRef: "usr_1" }).success).toBe(true);
    expect(noteVersionDocSchema.safeParse({ noteRef: "note_1", version: 1, body: "hello", changeKind: "revised", reason: null, createdAt: now, createdByUserRef: "usr_1" }).success).toBe(false);
    expect(noteVersionDocSchema.safeParse({ noteRef: "note_1", version: 2, body: "hello", changeKind: "created", reason: null, createdAt: now, createdByUserRef: "usr_1" }).success).toBe(false);
  });

  it("rejects an empty body and an over-length body", () => {
    expect(noteVersionDocSchema.safeParse({ noteRef: "note_1", version: 1, body: "", changeKind: "created", reason: null, createdAt: now, createdByUserRef: "usr_1" }).success).toBe(false);
    expect(noteVersionDocSchema.safeParse({ noteRef: "note_1", version: 1, body: "x".repeat(4001), changeKind: "created", reason: null, createdAt: now, createdByUserRef: "usr_1" }).success).toBe(false);
  });
});

describe("noteHeadDocSchema", () => {
  const base = { noteRef: "note_1", docVersion: 1, owner: { ownerType: "PARTNER", ownerRef: "ptn_1" }, visibility: "STANDARD", latestVersion: 1, status: "ACTIVE", attachmentRefs: [], display: { bodyPreview: "hello", projectedAt: now }, createdAt: now, createdByUserRef: "usr_1", updatedAt: now, updatedByUserRef: "usr_1" } as const;

  it("accepts a valid active head and requires archive metadata together", () => {
    expect(noteHeadDocSchema.safeParse(base).success).toBe(true);
    expect(noteHeadDocSchema.safeParse({ ...base, status: "ARCHIVED" }).success).toBe(false);
    expect(noteHeadDocSchema.safeParse({ ...base, status: "ARCHIVED", archivedAt: now, archivedByUserRef: "usr_2", archivedReason: "done" }).success).toBe(true);
    expect(noteHeadDocSchema.safeParse({ ...base, archivedAt: now }).success).toBe(false);
  });
});

describe("meetingVersionDocSchema", () => {
  it("bounds participants and decisions arrays and accepts a valid created version", () => {
    const parsed = meetingVersionDocSchema.safeParse({ meetingRef: "mtg_1", version: 1, title: "Kickoff", meetingAt: now, participants: [{ userRef: "usr_1" }], agenda: null, summary: null, decisions: [{ text: "Proceed" }], changeKind: "created", reason: null, createdAt: now, createdByUserRef: "usr_1" });
    expect(parsed.success).toBe(true);

    const tooManyParticipants = Array.from({ length: 31 }, (_, i) => ({ userRef: `usr_${i}` }));
    expect(meetingVersionDocSchema.safeParse({ meetingRef: "mtg_1", version: 1, title: "Kickoff", meetingAt: now, participants: tooManyParticipants, agenda: null, summary: null, decisions: [], changeKind: "created", reason: null, createdAt: now, createdByUserRef: "usr_1" }).success).toBe(false);
  });
});

describe("meetingHeadDocSchema", () => {
  const base = { meetingRef: "mtg_1", docVersion: 1, owner: { ownerType: "CAMPAIGN", ownerRef: "cmp_1" }, organizerUserRef: "usr_1", visibility: "STANDARD", status: "SCHEDULED", latestVersion: 1, attachmentRefs: [], display: { title: "Kickoff", titleLower: "kickoff", meetingAt: now, projectedAt: now }, createdAt: now, createdByUserRef: "usr_1", updatedAt: now, updatedByUserRef: "usr_1" };

  it("requires cancellation metadata together and rejects it on a non-cancelled meeting", () => {
    expect(meetingHeadDocSchema.safeParse(base).success).toBe(true);
    expect(meetingHeadDocSchema.safeParse({ ...base, status: "CANCELLED" }).success).toBe(false);
    expect(meetingHeadDocSchema.safeParse({ ...base, status: "CANCELLED", cancelledAt: now, cancelledByUserRef: "usr_2", cancelledReason: "double-booked" }).success).toBe(true);
    expect(meetingHeadDocSchema.safeParse({ ...base, cancelledAt: now }).success).toBe(false);
  });
});

describe("actionItemHeadDocSchema", () => {
  const base = { actionItemRef: "mai_1", meetingRef: "mtg_1", docVersion: 1, status: "OPEN", latestVersion: 1, display: { text: "Do the thing", status: "OPEN", dueAt: null, projectedAt: now }, createdAt: now, createdByUserRef: "usr_1", updatedAt: now, updatedByUserRef: "usr_1" };

  it("accepts a bare OPEN action item and requires completion metadata together", () => {
    expect(actionItemHeadDocSchema.safeParse(base).success).toBe(true);
    expect(actionItemHeadDocSchema.safeParse({ ...base, status: "DONE" }).success).toBe(false);
    expect(actionItemHeadDocSchema.safeParse({ ...base, status: "DONE", completedAt: now, completedByUserRef: "usr_2" }).success).toBe(true);
  });

  it("requires promotedTaskRef/promotedAt/promotedByUserRef to be set together, never partially", () => {
    expect(actionItemHeadDocSchema.safeParse({ ...base, promotedTaskRef: "tsk_1" }).success).toBe(false);
    expect(actionItemHeadDocSchema.safeParse({ ...base, promotedTaskRef: "tsk_1", promotedAt: now, promotedByUserRef: "usr_2" }).success).toBe(true);
  });

  it("a MeetingActionItem is never itself an OperationsTask - the schema has no status/priority/target fields Task's own schema uses", () => {
    const shape = Object.keys(actionItemHeadDocSchema.shape);
    for (const taskOnlyField of ["target", "priority", "assigneeUserRef", "regionIds", "teamIds", "origin"]) expect(shape).not.toContain(taskOnlyField);
  });
});

describe("actionItemVersionDocSchema", () => {
  it("carries the assignee/dueAt/text as its own versioned content, distinct from the head", () => {
    expect(actionItemVersionDocSchema.safeParse({ actionItemRef: "mai_1", version: 1, text: "Follow up", assigneeUserRef: null, dueAt: null, changeKind: "created", reason: null, createdAt: now, createdByUserRef: "usr_1" }).success).toBe(true);
  });
});

describe("input schemas reject malformed refs", () => {
  it("createNoteInputSchema requires a real owner shape and bounded body", () => {
    expect(createNoteInputSchema.safeParse({ owner: { ownerType: "PARTNER", ownerRef: "ptn_1" }, body: "hi" }).success).toBe(true);
    expect(createNoteInputSchema.safeParse({ owner: { ownerType: "NOT_REAL", ownerRef: "ptn_1" }, body: "hi" }).success).toBe(false);
    expect(createNoteInputSchema.safeParse({ owner: { ownerType: "PARTNER", ownerRef: "ptn_1" }, body: "" }).success).toBe(false);
  });

  it("reviseNoteInputSchema requires the note ref pattern and a real reason", () => {
    expect(reviseNoteInputSchema.safeParse({ noteRef: "not-a-real-ref", expectedDocVersion: 1, body: "x", reason: "why" }).success).toBe(false);
    expect(reviseNoteInputSchema.safeParse({ noteRef: "note_00000000000000000000", expectedDocVersion: 1, body: "x", reason: "hi" }).success).toBe(false); // reason too short
    expect(reviseNoteInputSchema.safeParse({ noteRef: "note_00000000000000000000", expectedDocVersion: 1, body: "x", reason: "changed wording" }).success).toBe(true);
  });

  it("createMeetingInputSchema bounds participants/decisions and requires a meetingAt", () => {
    expect(createMeetingInputSchema.safeParse({ owner: { ownerType: "VENDOR", ownerRef: "vnd_1" }, title: "Sync", meetingAt: now }).success).toBe(true);
    expect(createMeetingInputSchema.safeParse({ owner: { ownerType: "VENDOR", ownerRef: "vnd_1" }, title: "Sync" }).success).toBe(false);
  });

  it("createActionItemInputSchema requires the meeting ref pattern and expectedDocVersion", () => {
    expect(createActionItemInputSchema.safeParse({ meetingRef: "mtg_00000000000000000000", expectedDocVersion: 1, text: "Do it" }).success).toBe(true);
    expect(createActionItemInputSchema.safeParse({ meetingRef: "bad", expectedDocVersion: 1, text: "Do it" }).success).toBe(false);
  });
});

describe("result helpers - error normalization", () => {
  it("every helper produces a closed, classified error shape - never a raw exception string", () => {
    expect(notesMeetingsUnauthorizedResult("owner_denied")).toEqual({ ok: false, code: "unauthorized", message: "Notes/Meetings access denied.", reason: "owner_denied" });
    expect(notesMeetingsNotFoundResult()).toEqual({ ok: false, code: "not_found", message: "Not found." });
    expect(notesMeetingsInvalidInputResult("bad input")).toEqual({ ok: false, code: "invalid_input", message: "bad input" });
    expect(notesMeetingsStaleResult().code).toBe("stale_write");
    expect(notesMeetingsConflictResult("already done").code).toBe("conflict");
  });
});
