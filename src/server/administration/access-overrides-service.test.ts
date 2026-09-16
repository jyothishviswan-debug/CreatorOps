import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAdministrationAccessMock, getUserDocByRefMock, listUserDocsMock, writeAuditEventMock, runTransactionMock, collectionMock } = vi.hoisted(() => ({
  requireAdministrationAccessMock: vi.fn(),
  getUserDocByRefMock: vi.fn(),
  listUserDocsMock: vi.fn(),
  writeAuditEventMock: vi.fn().mockResolvedValue(undefined),
  runTransactionMock: vi.fn(),
  collectionMock: vi.fn(),
}));

vi.mock("@/server/authz/administration-gate", () => ({ requireAdministrationAccess: requireAdministrationAccessMock }));
vi.mock("@/server/authz/firestore", () => ({
  COLLECTIONS: { users: "users", accessGrants: "accessGrants", userAccessOverrides: "userAccessOverrides", scopeAssignments: "scopeAssignments" },
  getUserDocByRef: getUserDocByRefMock,
  listUserDocs: listUserDocsMock,
}));
vi.mock("@/server/authz/audit", () => ({ writeAuditEvent: writeAuditEventMock }));
vi.mock("@/server/firebase/admin", () => ({
  getAdminFirestore: () => ({ collection: collectionMock, runTransaction: runTransactionMock }),
}));

import { bulkSetAccessOverrides, setAccessOverride } from "./access-overrides-service";
import type { ActorContext } from "@/server/authz/types";

const actor: ActorContext = { uid: "uid-1", email: "admin@creatorops.com", role: "super_admin", displayName: "Admin", userRef: "ref-1" };
const targetDoc = { uid: "uid-2", email: "manager@creatorops.com", displayName: "Manager", role: "partnership_manager" as const, active: true, userRef: "ref-2", version: 1 };

type FakeDocRef = { __collection: string; __id: string };

function beforeEachSetup() {
  listUserDocsMock.mockResolvedValue({ users: [], nextCursor: null });
  collectionMock.mockImplementation((name: string) => ({ doc: vi.fn((id: string) => ({ __collection: name, __id: id })) }));
}
beforeEachSetup();

function makeTxGetRouter(routes: Record<string, unknown> = {}) {
  const notExists = { exists: false, data: () => undefined };
  return vi.fn(async (ref: FakeDocRef) => routes[`${ref.__collection}/${ref.__id}`] ?? notExists);
}

function makeTx(routes: Record<string, unknown> = {}) {
  const txSet = vi.fn();
  const txGet = makeTxGetRouter(routes);
  runTransactionMock.mockImplementation(async (callback: (tx: { get: typeof txGet; set: typeof txSet }) => unknown) => callback({ get: txGet, set: txSet }));
  return { txSet, txGet };
}

afterEach(() => {
  vi.clearAllMocks();
  beforeEachSetup();
});

describe("setAccessOverride", () => {
  it("is denied the same way requireAdministrationAccess denies it", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: false, reason: "action_denied" });
    const result = await setAccessOverride(actor, "ref-2", { featureId: "finance", value: "allow", expectedVersion: 0 }, "req-1");
    expect(result).toEqual({ ok: false, code: "unauthorized", message: expect.any(String), reason: "action_denied" });
    expect(getUserDocByRefMock).not.toHaveBeenCalled();
  });

  it("rejects an action id that isn't in this module's action catalog", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    const result = await setAccessOverride(actor, "ref-2", { featureId: "finance", actionId: "convert_lead", value: "allow", expectedVersion: 0 }, "req-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  it("returns not_found for an unresolvable userRef", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(null);
    const result = await setAccessOverride(actor, "tampered-ref", { featureId: "finance", value: "allow", expectedVersion: 0 }, "req-1");
    expect(result).toEqual({ ok: false, code: "not_found", message: expect.any(String) });
  });

  it("rejects a stale expectedVersion (stale override mutation rejected)", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    makeTx({ "userAccessOverrides/uid-2": { exists: true, data: () => ({ uid: "uid-2", version: 3, features: {} }) } });

    const result = await setAccessOverride(actor, "ref-2", { featureId: "finance", value: "allow", expectedVersion: 1 }, "req-1");
    expect(result).toEqual({ ok: false, code: "stale_write", message: expect.any(String) });
  });

  it("sets a module (feature-level) override to allow and writes an audit event", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    const { txSet } = makeTx({}); // no existing override doc - version 0

    const result = await setAccessOverride(actor, "ref-2", { featureId: "finance", value: "allow", expectedVersion: 0 }, "req-1");

    expect(result).toEqual({ ok: true, data: { version: 1 } });
    expect(txSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ uid: "uid-2", version: 1, features: { finance: { view: true, actions: {} } } }));
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ operation: "access_override.set" }));
  });

  it("sets an action-level override independent of the module's own view value", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    const { txSet } = makeTx({
      "userAccessOverrides/uid-2": { exists: true, data: () => ({ uid: "uid-2", version: 2, features: { finance: { view: true, actions: {} } } }) },
    });

    const result = await setAccessOverride(actor, "ref-2", { featureId: "finance", actionId: "approve_payables", value: "deny", expectedVersion: 2 }, "req-1");

    expect(result).toEqual({ ok: true, data: { version: 3 } });
    expect(txSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ features: { finance: { view: true, actions: { approve_payables: false } } } }));
  });

  it("reset (inherit) removes the override entry entirely once the feature has no view or action overrides left", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    const { txSet } = makeTx({
      "userAccessOverrides/uid-2": { exists: true, data: () => ({ uid: "uid-2", version: 1, features: { finance: { view: true, actions: {} } } }) },
    });

    const result = await setAccessOverride(actor, "ref-2", { featureId: "finance", value: "inherit", expectedVersion: 1 }, "req-1");

    expect(result).toEqual({ ok: true, data: { version: 2 } });
    expect(txSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ features: {} }));
  });

  it("blocks an override that would leave the last usable Administration manager with no way to recover access", async () => {
    const adminDoc = { ...targetDoc, uid: "uid-admin", userRef: "ref-admin", role: "super_admin" as const };
    const fullAdminGrant = { role: "super_admin", features: { administration: { view: true, actions: { manage_users: true, manage_overrides: true, manage_scope: true, manage_sensitive: true, view_audit: true } } } };
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(adminDoc);
    makeTx({
      "accessGrants/super_admin": { exists: true, data: () => fullAdminGrant },
      "scopeAssignments/uid-admin__GLOBAL": { exists: true, data: () => ({ type: "GLOBAL", uid: "uid-admin", grantedAt: "x", grantedBy: "y" }) },
    });

    const result = await setAccessOverride(actor, "ref-admin", { featureId: "administration", value: "deny", expectedVersion: 0 }, "req-1");
    expect(result).toEqual({ ok: false, code: "conflict", message: expect.any(String) });
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });

  it("allows the same denial when another active user still has full Administration-manager capability", async () => {
    const adminDoc = { ...targetDoc, uid: "uid-admin", userRef: "ref-admin", role: "super_admin" as const };
    const otherAdmin = { ...targetDoc, uid: "uid-other", role: "super_admin" as const };
    const fullAdminGrant = { role: "super_admin", features: { administration: { view: true, actions: { manage_users: true, manage_overrides: true, manage_scope: true, manage_sensitive: true, view_audit: true } } } };
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(adminDoc);
    listUserDocsMock.mockResolvedValue({ users: [otherAdmin], nextCursor: null });
    makeTx({
      "accessGrants/super_admin": { exists: true, data: () => fullAdminGrant },
      "scopeAssignments/uid-admin__GLOBAL": { exists: true, data: () => ({ type: "GLOBAL", uid: "uid-admin", grantedAt: "x", grantedBy: "y" }) },
      "scopeAssignments/uid-other__GLOBAL": { exists: true, data: () => ({ type: "GLOBAL", uid: "uid-other", grantedAt: "x", grantedBy: "y" }) },
    });

    const result = await setAccessOverride(actor, "ref-admin", { featureId: "administration", value: "deny", expectedVersion: 0 }, "req-1");
    expect(result.ok).toBe(true);
  });
});

describe("bulkSetAccessOverrides", () => {
  it("is denied the same way requireAdministrationAccess denies it", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: false, reason: "feature_denied" });
    const result = await bulkSetAccessOverrides(actor, "ref-2", { mode: "allow_all", expectedVersion: 0 }, "req-1");
    expect(result).toEqual({ ok: false, code: "unauthorized", message: expect.any(String), reason: "feature_denied" });
  });

  it("Allow All sets every module's view to true, preserving any existing action override", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    const { txSet } = makeTx({
      "userAccessOverrides/uid-2": { exists: true, data: () => ({ uid: "uid-2", version: 1, features: { finance: { view: false, actions: { approve_payables: true } } } }) },
    });

    const result = await bulkSetAccessOverrides(actor, "ref-2", { mode: "allow_all", expectedVersion: 1 }, "req-1");

    expect(result).toEqual({ ok: true, data: { version: 2 } });
    const written = txSet.mock.calls[0]![1];
    expect(written.features.finance).toEqual({ view: true, actions: { approve_payables: true } });
    expect(written.features.dashboard).toEqual({ view: true, actions: {} });
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ operation: "access_override.set", after: expect.objectContaining({ mode: "allow_all" }) }));
  });

  it("Deny All sets every module's view to false", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    const { txSet } = makeTx({});

    const result = await bulkSetAccessOverrides(actor, "ref-2", { mode: "deny_all", expectedVersion: 0 }, "req-1");

    expect(result).toEqual({ ok: true, data: { version: 1 } });
    const written = txSet.mock.calls[0]![1];
    expect(written.features.dashboard).toEqual({ view: false, actions: {} });
  });

  it("Reset All clears every override back to pure inheritance", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    const { txSet } = makeTx({
      "userAccessOverrides/uid-2": { exists: true, data: () => ({ uid: "uid-2", version: 4, features: { finance: { view: true, actions: {} }, dashboard: { view: false, actions: {} } } }) },
    });

    const result = await bulkSetAccessOverrides(actor, "ref-2", { mode: "reset_all", expectedVersion: 4 }, "req-1");

    expect(result).toEqual({ ok: true, data: { version: 5 } });
    expect(txSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ features: {} }));
  });

  it("rejects a stale bulk mutation", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    makeTx({ "userAccessOverrides/uid-2": { exists: true, data: () => ({ uid: "uid-2", version: 5, features: {} }) } });

    const result = await bulkSetAccessOverrides(actor, "ref-2", { mode: "reset_all", expectedVersion: 1 }, "req-1");
    expect(result).toEqual({ ok: false, code: "stale_write", message: expect.any(String) });
  });

  it("blocks a bulk Deny All that would leave the last usable Administration manager unable to recover access", async () => {
    const adminDoc = { ...targetDoc, uid: "uid-admin", userRef: "ref-admin", role: "super_admin" as const };
    const fullAdminGrant = { role: "super_admin", features: { administration: { view: true, actions: { manage_users: true, manage_overrides: true, manage_scope: true, manage_sensitive: true, view_audit: true } } } };
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(adminDoc);
    makeTx({
      "accessGrants/super_admin": { exists: true, data: () => fullAdminGrant },
      "scopeAssignments/uid-admin__GLOBAL": { exists: true, data: () => ({ type: "GLOBAL", uid: "uid-admin", grantedAt: "x", grantedBy: "y" }) },
    });

    const result = await bulkSetAccessOverrides(actor, "ref-admin", { mode: "deny_all", expectedVersion: 0 }, "req-1");
    expect(result).toEqual({ ok: false, code: "conflict", message: expect.any(String) });
  });
});
