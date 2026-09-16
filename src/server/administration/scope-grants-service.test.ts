import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAdministrationAccessMock, getUserDocByRefMock, writeAuditEventMock, getMock, setMock, deleteMock, docMock, collectionMock } = vi.hoisted(() => {
  const getMock = vi.fn();
  const setMock = vi.fn().mockResolvedValue(undefined);
  const deleteMock = vi.fn().mockResolvedValue(undefined);
  const docMock = vi.fn(() => ({ get: getMock, set: setMock, delete: deleteMock }));
  const collectionMock = vi.fn(() => ({ doc: docMock }));
  return {
    requireAdministrationAccessMock: vi.fn(),
    getUserDocByRefMock: vi.fn(),
    writeAuditEventMock: vi.fn().mockResolvedValue(undefined),
    getMock,
    setMock,
    deleteMock,
    docMock,
    collectionMock,
  };
});

vi.mock("@/server/authz/administration-gate", () => ({ requireAdministrationAccess: requireAdministrationAccessMock }));
vi.mock("@/server/authz/firestore", () => ({
  COLLECTIONS: { scopeAssignments: "scopeAssignments" },
  getUserDocByRef: getUserDocByRefMock,
}));
vi.mock("@/server/authz/audit", () => ({ writeAuditEvent: writeAuditEventMock }));
vi.mock("@/server/firebase/admin", () => ({ getAdminFirestore: () => ({ collection: collectionMock }) }));

import { addScopeGrant, removeScopeGrant } from "./scope-grants-service";
import type { ActorContext } from "@/server/authz/types";

const actor: ActorContext = { uid: "uid-1", email: "admin@creatorops.com", role: "super_admin", displayName: "Admin", userRef: "ref-1" };
const targetDoc = { uid: "uid-2", email: "manager@creatorops.com", displayName: "Manager", role: "partnership_manager" as const, active: true, userRef: "ref-2", version: 1 };

afterEach(() => {
  vi.clearAllMocks();
});

describe("addScopeGrant", () => {
  it("is denied the same way requireAdministrationAccess denies it", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: false, reason: "action_denied" });
    const result = await addScopeGrant(actor, "ref-2", { type: "REGION", region: "Kerala" }, "req-1");
    expect(result).toEqual({ ok: false, code: "unauthorized", message: expect.any(String), reason: "action_denied" });
    expect(getUserDocByRefMock).not.toHaveBeenCalled();
  });

  it("rejects malformed grant input", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    const result = await addScopeGrant(actor, "ref-2", { type: "REGION" }, "req-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  it("returns not_found for an unresolvable userRef (a tampered/unknown opaque token)", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(null);
    const result = await addScopeGrant(actor, "tampered-ref", { type: "REGION", region: "Kerala" }, "req-1");
    expect(result).toEqual({ ok: false, code: "not_found", message: expect.any(String) });
  });

  it("adds a REGION grant, writes it under the target's real uid, and records an audit event", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    getMock.mockResolvedValue({ exists: false, data: () => undefined });

    const result = await addScopeGrant(actor, "ref-2", { type: "REGION", region: "Kerala" }, "req-1");

    expect(result).toEqual({ ok: true, data: { created: true } });
    expect(docMock).toHaveBeenCalledWith("uid-2__REGION__Kerala");
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ type: "REGION", region: "Kerala", uid: "uid-2", grantedBy: "uid-1" }));
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "scope_grant.add", actor, target: { uid: "uid-2", userRef: "ref-2", email: "manager@creatorops.com" } }),
    );
  });
});

describe("removeScopeGrant", () => {
  it("returns not_found when the grant doesn't exist", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    getMock.mockResolvedValue({ exists: false, data: () => undefined });

    const result = await removeScopeGrant(actor, "ref-2", { type: "REGION", region: "Kerala" }, "req-1");
    expect(result).toEqual({ ok: false, code: "not_found", message: expect.any(String) });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("removes an existing grant and records an audit event", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    const existingGrant = { type: "REGION", region: "Kerala", uid: "uid-2", grantedAt: "x", grantedBy: "y" };
    getMock.mockResolvedValue({ exists: true, data: () => existingGrant });

    const result = await removeScopeGrant(actor, "ref-2", { type: "REGION", region: "Kerala" }, "req-1");

    expect(result).toEqual({ ok: true, data: { removed: true } });
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ operation: "scope_grant.remove", before: existingGrant, after: null }));
  });
});
