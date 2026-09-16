import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireAdministrationAccessMock,
  getUserDocMock,
  getUserDocByRefMock,
  listUserDocsMock,
  writeAuditEventMock,
  generateUserRefMock,
  getUserByEmailMock,
  createAuthUserMock,
  runTransactionMock,
  setMock,
  collectionMock,
} = vi.hoisted(() => ({
  requireAdministrationAccessMock: vi.fn(),
  getUserDocMock: vi.fn(),
  getUserDocByRefMock: vi.fn(),
  listUserDocsMock: vi.fn(),
  writeAuditEventMock: vi.fn().mockResolvedValue(undefined),
  generateUserRefMock: vi.fn(),
  getUserByEmailMock: vi.fn(),
  createAuthUserMock: vi.fn(),
  runTransactionMock: vi.fn(),
  setMock: vi.fn().mockResolvedValue(undefined),
  collectionMock: vi.fn(),
}));

vi.mock("@/server/authz/administration-gate", () => ({ requireAdministrationAccess: requireAdministrationAccessMock }));
vi.mock("@/server/authz/firestore", () => ({
  COLLECTIONS: { users: "users" },
  DEFAULT_LIST_PAGE_SIZE: 20,
  getUserDoc: getUserDocMock,
  getUserDocByRef: getUserDocByRefMock,
  listUserDocs: listUserDocsMock,
}));
vi.mock("@/server/authz/audit", () => ({ writeAuditEvent: writeAuditEventMock }));
vi.mock("@/server/authz/user-ref", () => ({ generateUserRef: generateUserRefMock }));
vi.mock("@/server/firebase/admin", () => ({
  getAdminAuth: () => ({ getUserByEmail: getUserByEmailMock, createUser: createAuthUserMock }),
  getAdminFirestore: () => ({
    collection: collectionMock,
    runTransaction: runTransactionMock,
  }),
}));

import { createUser, getUser, listUsers, updateUser } from "./users-service";
import type { ActorContext, UserDoc } from "@/server/authz/types";

const actor: ActorContext = { uid: "uid-1", email: "admin@creatorops.com", role: "super_admin", displayName: "Admin", userRef: "ref-1" };

const targetUserDoc: UserDoc = {
  uid: "uid-2",
  email: "manager@creatorops.com",
  role: "partnership_manager",
  active: true,
  displayName: "Manager",
  userRef: "ref-2",
  version: 3,
};

type FakeCollection = { doc: () => { set: typeof setMock }; where: (...args: unknown[]) => FakeCollection; limit: (...args: unknown[]) => FakeCollection };

beforeEachSetup();
function beforeEachSetup() {
  collectionMock.mockImplementation(() => {
    // Doubles as both a document-reference source (`.doc()`) and a
    // chainable query builder (`.where().where().limit()`) for the
    // last-Super-Admin count query - the mock only needs to be an opaque
    // token that flows through to the per-test `tx.get()` stub, not a
    // faithful Firestore query engine.
    const self: FakeCollection = {
      doc: vi.fn(() => ({ set: setMock })),
      where: vi.fn(() => self),
      limit: vi.fn(() => self),
    };
    return self;
  });
}

afterEach(() => {
  vi.clearAllMocks();
  beforeEachSetup();
});

describe("listUsers", () => {
  it("is denied the same way requireAdministrationAccess denies it", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: false, reason: "not_active" });
    const result = await listUsers(actor, {});
    expect(result).toEqual({ ok: false, code: "unauthorized", message: expect.any(String), reason: "not_active" });
    expect(listUserDocsMock).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range page size instead of silently clamping past the input schema", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    const result = await listUsers(actor, { limit: 5000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  it("passes a stable cursor straight through to the bounded query, and returns DTOs with no raw uid (pagination stable)", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    listUserDocsMock.mockResolvedValue({ users: [targetUserDoc], nextCursor: { email: "manager@creatorops.com", userRef: "ref-2" } });

    const page1 = await listUsers(actor, { limit: 1 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) throw new Error("unreachable");
    expect(page1.data.users).toEqual([{ userRef: "ref-2", email: "manager@creatorops.com", displayName: "Manager", role: "partnership_manager", active: true, version: 3 }]);
    expect(page1.data.users[0]).not.toHaveProperty("uid");

    await listUsers(actor, { limit: 1, cursor: page1.data.nextCursor! });
    expect(listUserDocsMock).toHaveBeenLastCalledWith({ limit: 1, cursor: { email: "manager@creatorops.com", userRef: "ref-2" }, role: undefined, active: undefined });
  });
});

describe("getUser", () => {
  it("returns not_found for a userRef that resolves to nothing (opaque-token tampering rejected)", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(null);
    const result = await getUser(actor, "tampered-or-guessed-token");
    expect(result).toEqual({ ok: false, code: "not_found", message: expect.any(String) });
  });

  it("returns a DTO with no Firebase uid anywhere in it (no secret/raw UID leakage in safe DTOs)", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetUserDoc);
    const result = await getUser(actor, "ref-2");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(JSON.stringify(result.data)).not.toContain("uid-2");
    expect(Object.keys(result.data).sort()).toEqual(["active", "displayName", "email", "role", "userRef", "version"]);
  });
});

describe("createUser", () => {
  const input = { email: "new@creatorops.com", password: "a-strong-password", displayName: "New User", role: "viewer" as const };

  it("is denied the same way requireAdministrationAccess denies it, before touching Auth", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: false, reason: "action_denied" });
    const result = await createUser(actor, input, "req-1");
    expect(result).toEqual({ ok: false, code: "unauthorized", message: expect.any(String), reason: "action_denied" });
    expect(getUserByEmailMock).not.toHaveBeenCalled();
  });

  it("creates a brand-new Auth user and Firestore admission record, and writes an audit event", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserByEmailMock.mockRejectedValue(Object.assign(new Error("not found"), { code: "auth/user-not-found" }));
    createAuthUserMock.mockResolvedValue({ uid: "uid-new" });
    getUserDocMock.mockResolvedValue(null);
    generateUserRefMock.mockReturnValue("ref-new");

    const result = await createUser(actor, input, "req-1");

    expect(result).toEqual({
      ok: true,
      data: { userRef: "ref-new", email: input.email, displayName: input.displayName, role: input.role, active: true, version: 1 },
    });
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ uid: "uid-new", userRef: "ref-new", version: 1 }));
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ operation: "user.create" }));
    // The password must never appear in the audit write.
    const auditCall = writeAuditEventMock.mock.calls[0]![0];
    expect(JSON.stringify(auditCall)).not.toContain(input.password);
  });

  it("is idempotent: retrying with the same email returns the existing user without creating a duplicate or a second audit event", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserByEmailMock.mockResolvedValue({ uid: "uid-existing" });
    getUserDocMock.mockResolvedValue({ ...targetUserDoc, uid: "uid-existing", email: input.email });

    const result = await createUser(actor, input, "req-2");

    expect(result.ok).toBe(true);
    expect(createAuthUserMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });
});

describe("updateUser", () => {
  function makeTx(getResults: unknown[]) {
    const txSet = vi.fn();
    const txGet = vi.fn();
    for (const value of getResults) txGet.mockResolvedValueOnce(value);
    runTransactionMock.mockImplementation(async (callback: (tx: { get: typeof txGet; set: typeof txSet }) => unknown) => callback({ get: txGet, set: txSet }));
    return { txSet, txGet };
  }

  it("is denied the same way requireAdministrationAccess denies it, before touching Firestore", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: false, reason: "scope_denied" });
    const result = await updateUser(actor, "ref-2", { active: false, expectedVersion: 3 }, "req-1");
    expect(result).toEqual({ ok: false, code: "unauthorized", message: expect.any(String), reason: "scope_denied" });
    expect(getUserDocByRefMock).not.toHaveBeenCalled();
  });

  it("rejects a stale expectedVersion (stale mutation rejected)", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetUserDoc);
    makeTx([{ exists: true, data: () => targetUserDoc }]);

    const result = await updateUser(actor, "ref-2", { displayName: "New Name", expectedVersion: targetUserDoc.version - 1 }, "req-1");
    expect(result).toEqual({ ok: false, code: "stale_write", message: expect.any(String) });
  });

  it("changes a role and writes a user.role_change audit event", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetUserDoc);
    const { txSet } = makeTx([{ exists: true, data: () => targetUserDoc }]);

    const result = await updateUser(actor, "ref-2", { role: "partnership_head", expectedVersion: targetUserDoc.version }, "req-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.role).toBe("partnership_head");
    expect(result.data.version).toBe(targetUserDoc.version + 1);
    expect(txSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "partnership_head", version: targetUserDoc.version + 1 }));
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ operation: "user.role_change", before: { role: "partnership_manager" }, after: { role: "partnership_head" } }));
  });

  it("deactivates a non-Super-Admin user and writes a user.deactivate audit event", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetUserDoc);
    makeTx([{ exists: true, data: () => targetUserDoc }]);

    const result = await updateUser(actor, "ref-2", { active: false, expectedVersion: targetUserDoc.version }, "req-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.active).toBe(false);
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ operation: "user.deactivate" }));
  });

  it("re-activating a user writes a user.activate audit event", async () => {
    const inactiveDoc: UserDoc = { ...targetUserDoc, active: false };
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(inactiveDoc);
    makeTx([{ exists: true, data: () => inactiveDoc }]);

    const result = await updateUser(actor, "ref-2", { active: true, expectedVersion: inactiveDoc.version }, "req-1");

    expect(result.ok).toBe(true);
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ operation: "user.activate" }));
  });

  it("blocks deactivating the last active Super Admin (final Super Admin protection)", async () => {
    const lastSuperAdmin: UserDoc = { ...targetUserDoc, uid: "uid-admin", role: "super_admin", active: true, version: 1 };
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(lastSuperAdmin);
    // First tx.get() = the target doc itself; second = the active-super-admin
    // count query, capped at 2 results - only this one super admin exists.
    makeTx([{ exists: true, data: () => lastSuperAdmin }, { size: 1 }]);

    const result = await updateUser(actor, "ref-2", { active: false, expectedVersion: 1 }, "req-1");
    expect(result).toEqual({ ok: false, code: "conflict", message: expect.any(String) });
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });

  it("blocks reassigning the last active Super Admin away from the role", async () => {
    const lastSuperAdmin: UserDoc = { ...targetUserDoc, uid: "uid-admin", role: "super_admin", active: true, version: 1 };
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(lastSuperAdmin);
    makeTx([{ exists: true, data: () => lastSuperAdmin }, { size: 1 }]);

    const result = await updateUser(actor, "ref-2", { role: "viewer", expectedVersion: 1 }, "req-1");
    expect(result).toEqual({ ok: false, code: "conflict", message: expect.any(String) });
  });

  it("allows deactivating a Super Admin when another active Super Admin still exists", async () => {
    const superAdmin: UserDoc = { ...targetUserDoc, uid: "uid-admin", role: "super_admin", active: true, version: 1 };
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(superAdmin);
    // Two active super admins exist, so removing one is fine.
    makeTx([{ exists: true, data: () => superAdmin }, { size: 2 }]);

    const result = await updateUser(actor, "ref-2", { active: false, expectedVersion: 1 }, "req-1");
    expect(result.ok).toBe(true);
  });

  it("returns not_found for a target userRef that doesn't resolve", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(null);
    const result = await updateUser(actor, "tampered-ref", { active: false, expectedVersion: 1 }, "req-1");
    expect(result).toEqual({ ok: false, code: "not_found", message: expect.any(String) });
  });

  it("rejects an empty patch", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetUserDoc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateUser(actor, "ref-2", { expectedVersion: 1 } as any, "req-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });
});
