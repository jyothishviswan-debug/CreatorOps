import { describe, expect, it } from "vitest";

import { buildReminderEvent, redactReminderEventMetadata } from "./reminder-events";

describe("redactReminderEventMetadata", () => {
  it("keeps only allowlisted keys with values in the expected shape", () => {
    const clean = redactReminderEventMetadata({ fromStatus: "SCHEDULED", toStatus: "DISMISSED", reason: "no longer needed", junk: 1 });
    expect(clean).toEqual({ fromStatus: "SCHEDULED", toStatus: "DISMISSED", reason: "no longer needed" });
  });

  it("drops a key whose value fails its own check", () => {
    expect(redactReminderEventMetadata({ fromStatus: "NOPE" })).toBeNull();
    expect(redactReminderEventMetadata({ rescheduleCount: -1 })).toBeNull();
    expect(redactReminderEventMetadata({ rescheduleCount: 3 })).toEqual({ rescheduleCount: 3 });
  });

  it("scrubs an identity-shaped reason", () => {
    expect(redactReminderEventMetadata({ reason: "bank account 123456789012 pending" })).toBeNull();
  });

  it("returns null when nothing survives", () => {
    expect(redactReminderEventMetadata({ foo: "bar" })).toBeNull();
  });
});

describe("buildReminderEvent", () => {
  it("produces a schema-valid event with metadata already redacted", () => {
    const event = buildReminderEvent({ kind: "REMINDER_CREATED", actorUserRef: "user_1", metadata: { origin: "MANUAL", secret: "drop" }, requestId: "req_1", createdAt: new Date().toISOString() });
    expect(event.kind).toBe("REMINDER_CREATED");
    expect(event.metadata).toEqual({ origin: "MANUAL" });
  });
});
