import { describe, expect, it } from "vitest";

import { buildTaskEvent, redactTaskEventMetadata } from "./task-events";

describe("redactTaskEventMetadata", () => {
  it("keeps only allowlisted keys with values in the expected shape", () => {
    const clean = redactTaskEventMetadata({ version: 2, fromStatus: "OPEN", toStatus: "IN_PROGRESS", reason: "Started work", notAllowed: "drop me", amountMinor: 5000 });
    expect(clean).toEqual({ version: 2, fromStatus: "OPEN", toStatus: "IN_PROGRESS", reason: "Started work" });
  });

  it("drops a key whose value fails its own check (wrong enum member, wrong type)", () => {
    expect(redactTaskEventMetadata({ fromStatus: "NOT_A_REAL_STATUS" })).toBeNull();
    expect(redactTaskEventMetadata({ version: "two" })).toBeNull();
  });

  it("scrubs an identity-shaped note (PAN/Aadhaar/email/long digit run) even under the allowlisted `reason` key", () => {
    expect(redactTaskEventMetadata({ reason: "PAN ABCDE1234F on file" })).toBeNull();
    expect(redactTaskEventMetadata({ reason: "call 9876543210 to confirm" })).toBeNull();
    expect(redactTaskEventMetadata({ reason: "contact jane@example.com" })).toBeNull();
    expect(redactTaskEventMetadata({ reason: "waiting on partner signature" })).toEqual({ reason: "waiting on partner signature" });
  });

  it("returns null (not an empty object) when nothing survives", () => {
    expect(redactTaskEventMetadata({ foo: "bar" })).toBeNull();
    expect(redactTaskEventMetadata(null)).toBeNull();
    expect(redactTaskEventMetadata(undefined)).toBeNull();
  });
});

describe("buildTaskEvent", () => {
  it("produces a schema-valid event with metadata already redacted", () => {
    const event = buildTaskEvent({ kind: "TASK_CREATED", version: 1, actorUserRef: "user_1", metadata: { targetType: "PARTNER", targetRef: "p_1", secretAmountMinor: 999 }, requestId: "req_1", createdAt: new Date().toISOString() });
    expect(event.kind).toBe("TASK_CREATED");
    expect(event.metadata).toEqual({ targetType: "PARTNER", targetRef: "p_1" });
  });
});
