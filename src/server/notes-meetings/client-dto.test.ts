import { describe, expect, it } from "vitest";

import { toActionItemDto, toMeetingDto, toMeetingVersionDto, toNoteDto, toNoteVersionDto, withAssignee } from "./client-dto";
import type { ActionItemHeadDoc, MeetingHeadDoc, MeetingVersionDoc, NoteHeadDoc, NoteVersionDoc } from "./types";

const now = new Date().toISOString();
const names = new Map<string, string | null>([
  ["usr_1", "Meera Das"],
  ["usr_2", "Ananya Rao"],
]);

describe("toNoteDto - sensitivity/visibility redaction (spec section 5)", () => {
  const head: NoteHeadDoc = { noteRef: "note_1", docVersion: 1, owner: { ownerType: "PARTNER", ownerRef: "ptn_1" }, visibility: "RESTRICTED", latestVersion: 1, status: "ACTIVE", archivedAt: null, archivedByUserRef: null, archivedReason: null, attachmentRefs: ["att_1"], display: { bodyPreview: "hi", projectedAt: now }, createdAt: now, createdByUserRef: "usr_1", updatedAt: now, updatedByUserRef: "usr_1" };
  const version: NoteVersionDoc = { noteRef: "note_1", version: 1, body: "This is the restricted body.", changeKind: "created", reason: null, createdAt: now, createdByUserRef: "usr_1" };

  it("omits body and attachments for an actor without the sensitive category, but still shows existence/author/time (never hides the record entirely)", () => {
    const dto = toNoteDto(head, version, { owner: { ownerType: "PARTNER", ownerRef: "ptn_1", ownerDisplayName: "Acme" }, sensitiveVisible: false, names, attachments: [{ attachmentRef: "att_1", fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 10, uploadedAt: now, uploadedByUserRef: "usr_1", uploadedByDisplayName: "Meera Das" }] });
    expect(dto.redacted).toBe(true);
    expect(dto.body).toBeNull();
    expect(dto.attachments).toBeNull();
    expect(dto.attachmentCount).toBe(1); // count is safe metadata, not content
    expect(dto.createdByDisplayName).toBe("Meera Das");
    expect(dto.visibility).toBe("RESTRICTED");
  });

  it("shows full content for an actor WITH the sensitive category", () => {
    const dto = toNoteDto(head, version, { owner: { ownerType: "PARTNER", ownerRef: "ptn_1", ownerDisplayName: "Acme" }, sensitiveVisible: true, names, attachments: [] });
    expect(dto.redacted).toBe(false);
    expect(dto.body).toBe("This is the restricted body.");
  });

  it("STANDARD visibility is never redacted regardless of the sensitive-category flag", () => {
    const standardHead = { ...head, visibility: "STANDARD" as const };
    const dto = toNoteDto(standardHead, version, { owner: { ownerType: "PARTNER", ownerRef: "ptn_1", ownerDisplayName: "Acme" }, sensitiveVisible: false, names, attachments: [] });
    expect(dto.redacted).toBe(false);
    expect(dto.body).toBe(version.body);
  });

  it("a missing display-name lookup falls back to null, never a fabricated name", () => {
    const dto = toNoteDto(head, version, { owner: { ownerType: "PARTNER", ownerRef: "ptn_1", ownerDisplayName: null }, sensitiveVisible: true, names: new Map(), attachments: [] });
    expect(dto.createdByDisplayName).toBeNull();
    expect(dto.owner.ownerDisplayName).toBeNull();
  });
});

describe("toNoteVersionDto - history redaction follows the SAME rule as the current body", () => {
  it("redacts a past version's body identically to the current one", () => {
    const version: NoteVersionDoc = { noteRef: "note_1", version: 1, body: "secret", changeKind: "created", reason: null, createdAt: now, createdByUserRef: "usr_1" };
    expect(toNoteVersionDto(version, true, "Meera Das").body).toBeNull();
    expect(toNoteVersionDto(version, false, "Meera Das").body).toBe("secret");
  });
});

describe("toMeetingDto - redaction covers participants/agenda/summary/decisions together", () => {
  const head: MeetingHeadDoc = { meetingRef: "mtg_1", docVersion: 1, owner: { ownerType: "CAMPAIGN", ownerRef: "cmp_1" }, organizerUserRef: "usr_1", visibility: "RESTRICTED", status: "SCHEDULED", latestVersion: 1, cancelledAt: null, cancelledByUserRef: null, cancelledReason: null, attachmentRefs: [], display: { title: "Board sync", titleLower: "board sync", meetingAt: now, projectedAt: now }, createdAt: now, createdByUserRef: "usr_1", updatedAt: now, updatedByUserRef: "usr_1" };
  const version: MeetingVersionDoc = { meetingRef: "mtg_1", version: 1, title: "Board sync", meetingAt: now, participants: [{ userRef: "usr_2" }], agenda: "Discuss budget", summary: "Approved budget", decisions: [{ text: "Ship v2" }], changeKind: "created", reason: null, createdAt: now, createdByUserRef: "usr_1" };

  it("redacts participants/agenda/summary/decisions but keeps title/status/organizer visible", () => {
    const dto = toMeetingDto(head, version, { owner: { ownerType: "CAMPAIGN", ownerRef: "cmp_1", ownerDisplayName: "Community Stories" }, sensitiveVisible: false, names, attachments: [] });
    expect(dto.redacted).toBe(true);
    expect(dto.participants).toBeNull();
    expect(dto.agenda).toBeNull();
    expect(dto.summary).toBeNull();
    expect(dto.decisions).toBeNull();
    expect(dto.title).toBe("Board sync"); // title is head-level display, not gated (list needs a label)
    expect(dto.organizerDisplayName).toBe("Meera Das");
  });

  it("shows full content when authorized", () => {
    const dto = toMeetingDto(head, version, { owner: { ownerType: "CAMPAIGN", ownerRef: "cmp_1", ownerDisplayName: "Community Stories" }, sensitiveVisible: true, names, attachments: [] });
    expect(dto.participants).toEqual([{ userRef: "usr_2", displayName: "Ananya Rao" }]);
    expect(dto.decisions).toEqual(["Ship v2"]);
  });
});

describe("toMeetingVersionDto - resolves participant names per version, redacts identically to current", () => {
  it("resolves each participant's safe label", () => {
    const version: MeetingVersionDoc = { meetingRef: "mtg_1", version: 2, title: "Board sync", meetingAt: now, participants: [{ userRef: "usr_1" }, { userRef: "usr_2" }], agenda: null, summary: null, decisions: [], changeKind: "revised", reason: "added participant", createdAt: now, createdByUserRef: "usr_1" };
    const dto = toMeetingVersionDto(version, false, names);
    expect(dto.participants).toEqual([
      { userRef: "usr_1", displayName: "Meera Das" },
      { userRef: "usr_2", displayName: "Ananya Rao" },
    ]);
  });
});

describe("toActionItemDto / withAssignee - a MeetingActionItem is never labeled with Task fields", () => {
  const head: ActionItemHeadDoc = { actionItemRef: "mai_1", meetingRef: "mtg_1", docVersion: 1, status: "OPEN", latestVersion: 1, completedAt: null, completedByUserRef: null, cancelledAt: null, cancelledByUserRef: null, cancelledReason: null, promotedTaskRef: null, promotedAt: null, promotedByUserRef: null, linkedReminderRef: null, display: { text: "Follow up with legal", status: "OPEN", dueAt: null, projectedAt: now }, createdAt: now, createdByUserRef: "usr_1", updatedAt: now, updatedByUserRef: "usr_1" };

  it("resolves the assignee's safe label only via withAssignee, and reflects promotion linkage when present", () => {
    const dto = withAssignee(toActionItemDto(head, { names }), "usr_2", names);
    expect(dto.assigneeDisplayName).toBe("Ananya Rao");
    expect(dto.promotedTaskRef).toBeNull();

    const promoted: ActionItemHeadDoc = { ...head, promotedTaskRef: "tsk_1", promotedAt: now, promotedByUserRef: "usr_1" };
    const promotedDto = toActionItemDto(promoted, { names, promotedTaskDisplayName: "Meeting action item: Follow up with legal" });
    expect(promotedDto.promotedTaskRef).toBe("tsk_1");
    expect(promotedDto.promotedTaskDisplayName).toBe("Meeting action item: Follow up with legal");
    expect(promotedDto.promotedByDisplayName).toBe("Meera Das");
  });
});
