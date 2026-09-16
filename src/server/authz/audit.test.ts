import { afterEach, describe, expect, it, vi } from "vitest";

const { setMock, collectionMock } = vi.hoisted(() => {
  const setMock = vi.fn().mockResolvedValue(undefined);
  const docMock = vi.fn(() => ({ set: setMock }));
  const collectionMock = vi.fn(() => ({ doc: docMock }));
  return { setMock, docMock, collectionMock };
});

vi.mock("@/server/firebase/admin", () => ({ getAdminFirestore: () => ({ collection: collectionMock }) }));

import { writeAuditEvent } from "./audit";
import type { ActorContext } from "./types";

const actor: ActorContext = { uid: "uid-1", email: "admin@creatorops.com", role: "super_admin", displayName: "Admin", userRef: "ref-1" };

afterEach(() => {
  vi.clearAllMocks();
});

describe("writeAuditEvent", () => {
  it("writes an event with the given operation, actor, target, and metadata", async () => {
    await writeAuditEvent({
      operation: "user.role_change",
      actor,
      actorUserRef: actor.userRef,
      target: { uid: "uid-2", userRef: "ref-2", email: "viewer@creatorops.com" },
      targetRole: "analyst",
      before: { role: "viewer" },
      after: { role: "analyst" },
      requestId: "req-1",
    });

    expect(collectionMock).toHaveBeenCalledWith("auditEvents");
    expect(setMock).toHaveBeenCalledTimes(1);
    const written = setMock.mock.calls[0]![0];
    expect(written).toMatchObject({
      operation: "user.role_change",
      actorUid: "uid-1",
      actorUserRef: "ref-1",
      targetUid: "uid-2",
      targetUserRef: "ref-2",
      targetRole: "analyst",
      before: { role: "viewer" },
      after: { role: "analyst" },
      requestId: "req-1",
    });
    expect(typeof written.createdAt).toBe("string");
  });

  it("redacts any metadata key that looks like a secret before writing (never log passwords/tokens/secrets)", async () => {
    await writeAuditEvent({
      operation: "user.create",
      actor,
      actorUserRef: actor.userRef,
      before: null,
      after: { email: "new@creatorops.com", password: "hunter2", sessionCookie: "abc", apiSecret: "xyz", displayName: "New" },
      requestId: "req-2",
    });

    const written = setMock.mock.calls[0]![0];
    expect(written.after).toEqual({ email: "new@creatorops.com", displayName: "New" });
    expect(written.after.password).toBeUndefined();
    expect(written.after.sessionCookie).toBeUndefined();
    expect(written.after.apiSecret).toBeUndefined();
  });

  it("fails closed: throws rather than silently writing a malformed audit event", async () => {
    await expect(
      writeAuditEvent({
        // @ts-expect-error deliberately malformed for the test
        operation: "not_a_real_operation",
        actor,
        actorUserRef: actor.userRef,
        before: null,
        after: null,
        requestId: "req-3",
      }),
    ).rejects.toThrow();
    expect(setMock).not.toHaveBeenCalled();
  });
});
