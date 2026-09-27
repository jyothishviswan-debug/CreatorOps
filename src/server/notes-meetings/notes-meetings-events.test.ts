import { describe, expect, it } from "vitest";

import { buildNotesMeetingsEvent, redactNotesMeetingsEventMetadata } from "./notes-meetings-events";

describe("redactNotesMeetingsEventMetadata", () => {
  it("keeps only allowlisted keys with values in the expected shape", () => {
    const clean = redactNotesMeetingsEventMetadata({ version: 2, ownerType: "PARTNER", ownerRef: "ptn_1", visibility: "STANDARD", reason: "Follow-up scheduled", notAllowed: "drop me", amountMinor: 5000 });
    expect(clean).toEqual({ version: 2, ownerType: "PARTNER", ownerRef: "ptn_1", visibility: "STANDARD", reason: "Follow-up scheduled" });
  });

  it("drops a key whose value fails its own check (wrong enum member, wrong type)", () => {
    expect(redactNotesMeetingsEventMetadata({ ownerType: "NOT_A_REAL_OWNER" })).toBeNull();
    expect(redactNotesMeetingsEventMetadata({ version: "two" })).toBeNull();
    expect(redactNotesMeetingsEventMetadata({ status: "SOMETHING_ELSE" })).toBeNull();
  });

  it("scrubs an identity-shaped note (PAN/Aadhaar/email/long digit run/currency) even under the allowlisted `reason` key - never duplicates restricted content into an event", () => {
    expect(redactNotesMeetingsEventMetadata({ reason: "PAN ABCDE1234F on file" })).toBeNull();
    expect(redactNotesMeetingsEventMetadata({ reason: "call 9876543210 to confirm" })).toBeNull();
    expect(redactNotesMeetingsEventMetadata({ reason: "contact jane@example.com" })).toBeNull();
    expect(redactNotesMeetingsEventMetadata({ reason: "paid rs. 5000 today" })).toBeNull();
    expect(redactNotesMeetingsEventMetadata({ reason: "revised after partner call" })).toEqual({ reason: "revised after partner call" });
  });

  it("never carries the Note/Meeting body, summary, agenda or decisions - those keys are not in the allowlist at all", () => {
    expect(redactNotesMeetingsEventMetadata({ body: "some restricted note text", summary: "MoM text", agenda: "agenda text", decisions: ["x"] })).toBeNull();
  });

  it("returns null (not an empty object) when nothing survives", () => {
    expect(redactNotesMeetingsEventMetadata({ foo: "bar" })).toBeNull();
    expect(redactNotesMeetingsEventMetadata(null)).toBeNull();
    expect(redactNotesMeetingsEventMetadata(undefined)).toBeNull();
  });

  it("accepts a targetRef-shaped ownerRef, taskRef, actionItemRef, meetingRef and assignee refs", () => {
    const clean = redactNotesMeetingsEventMetadata({ meetingRef: "mtg_abc123", actionItemRef: "mai_def456", taskRef: "tsk_ghi789", assigneeUserRef: "usr_1", dueAt: "2026-01-01T00:00:00.000Z" });
    expect(clean).toEqual({ meetingRef: "mtg_abc123", actionItemRef: "mai_def456", taskRef: "tsk_ghi789", assigneeUserRef: "usr_1", dueAt: "2026-01-01T00:00:00.000Z" });
  });
});

describe("buildNotesMeetingsEvent", () => {
  it("produces a schema-valid event with metadata already redacted", () => {
    const event = buildNotesMeetingsEvent({ kind: "NOTE_CREATED", actorUserRef: "usr_1", metadata: { ownerType: "PARTNER", ownerRef: "ptn_1", secretAmountMinor: 999 }, requestId: "req_1", createdAt: new Date().toISOString() });
    expect(event.kind).toBe("NOTE_CREATED");
    expect(event.metadata).toEqual({ ownerType: "PARTNER", ownerRef: "ptn_1" });
  });

  it("produces a valid ACTION_ITEM_PROMOTED event carrying only the structural refs, never the action item's own text", () => {
    const event = buildNotesMeetingsEvent({ kind: "ACTION_ITEM_PROMOTED", actorUserRef: "usr_1", metadata: { taskRef: "tsk_abc", meetingRef: "mtg_abc", actionItemRef: "mai_abc", text: "leaked text should be dropped" }, requestId: "req_2", createdAt: new Date().toISOString() });
    expect(event.metadata).toEqual({ taskRef: "tsk_abc", meetingRef: "mtg_abc", actionItemRef: "mai_abc" });
  });
});
