import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAdministrationAccessMock, getUserDocByRefMock, getActorScopeGrantsMock, getAccessGrantDocMock, getSensitiveAccessGrantDocMock, getUserAccessOverrideDocMock } = vi.hoisted(
  () => ({
    requireAdministrationAccessMock: vi.fn(),
    getUserDocByRefMock: vi.fn(),
    getActorScopeGrantsMock: vi.fn(),
    getAccessGrantDocMock: vi.fn(),
    getSensitiveAccessGrantDocMock: vi.fn(),
    getUserAccessOverrideDocMock: vi.fn(),
  }),
);

vi.mock("@/server/authz/administration-gate", () => ({ requireAdministrationAccess: requireAdministrationAccessMock }));
vi.mock("@/server/authz/scope", () => ({ getActorScopeGrants: getActorScopeGrantsMock }));
vi.mock("@/server/authz/firestore", () => ({
  getUserDocByRef: getUserDocByRefMock,
  getAccessGrantDoc: getAccessGrantDocMock,
  getSensitiveAccessGrantDoc: getSensitiveAccessGrantDocMock,
  getUserAccessOverrideDoc: getUserAccessOverrideDocMock,
}));

import { getEffectiveAccess } from "./effective-access-service";
import type { ActorContext, UserDoc } from "@/server/authz/types";

const actor: ActorContext = { uid: "uid-1", email: "admin@creatorops.com", role: "super_admin", displayName: "Admin", userRef: "ref-1" };

const targetDoc: UserDoc = {
  uid: "uid-2",
  email: "manager@creatorops.com",
  role: "partnership_manager",
  active: true,
  displayName: "Manager",
  userRef: "ref-2",
  version: 1,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("getEffectiveAccess", () => {
  it("is denied the same way requireAdministrationAccess denies it, before resolving the target", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: false, reason: "feature_denied" });
    const result = await getEffectiveAccess(actor, "ref-2");
    expect(result).toEqual({ ok: false, code: "unauthorized", message: expect.any(String), reason: "feature_denied" });
    expect(getUserDocByRefMock).not.toHaveBeenCalled();
  });

  it("returns not_found for an unresolvable userRef (a tampered/unknown opaque token)", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(null);
    const result = await getEffectiveAccess(actor, "tampered-ref");
    expect(result).toEqual({ ok: false, code: "not_found", message: expect.any(String) });
  });

  it("a module with no override resolves to the role baseline, sourced 'role'", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    getActorScopeGrantsMock.mockResolvedValue([]);
    getAccessGrantDocMock.mockResolvedValue({ role: "partnership_manager", features: { partners: { view: true, actions: { create: true } } } });
    getSensitiveAccessGrantDocMock.mockResolvedValue(null);
    getUserAccessOverrideDocMock.mockResolvedValue(null);

    const result = await getEffectiveAccess(actor, "ref-2");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.modules.partners.roleBaseline).toBe(true);
    expect(result.data.modules.partners.override).toBe("inherit");
    expect(result.data.modules.partners.effective).toEqual({ value: true, source: "role" });
    expect(result.data.overridesVersion).toBe(0);
    expect(result.data.activeFeatures).toContain("partners");
  });

  it("an explicit user deny overrides a role allow, sourced 'override_deny'", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    getActorScopeGrantsMock.mockResolvedValue([]);
    getAccessGrantDocMock.mockResolvedValue({ role: "partnership_manager", features: { partners: { view: true, actions: {} } } });
    getSensitiveAccessGrantDocMock.mockResolvedValue(null);
    getUserAccessOverrideDocMock.mockResolvedValue({ uid: "uid-2", version: 3, features: { partners: { view: false, actions: {} } } });

    const result = await getEffectiveAccess(actor, "ref-2");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.modules.partners.roleBaseline).toBe(true);
    expect(result.data.modules.partners.override).toBe("deny");
    expect(result.data.modules.partners.effective).toEqual({ value: false, source: "override_deny" });
    expect(result.data.overridesVersion).toBe(3);
    expect(result.data.activeFeatures).not.toContain("partners");
  });

  it("an explicit user allow overrides a role deny, sourced 'override_allow'", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    getActorScopeGrantsMock.mockResolvedValue([]);
    getAccessGrantDocMock.mockResolvedValue({ role: "partnership_manager", features: {} }); // no finance entry - role denies
    getSensitiveAccessGrantDocMock.mockResolvedValue(null);
    getUserAccessOverrideDocMock.mockResolvedValue({ uid: "uid-2", version: 1, features: { finance: { view: true, actions: {} } } });

    const result = await getEffectiveAccess(actor, "ref-2");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.modules.finance.roleBaseline).toBe(false);
    expect(result.data.modules.finance.override).toBe("allow");
    expect(result.data.modules.finance.effective).toEqual({ value: true, source: "override_allow" });
  });

  it("an action override is independent of the module's own baseline, but effective action access requires effective module access", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    getActorScopeGrantsMock.mockResolvedValue([]);
    // Role: finance module view=true, approve_payables=false.
    getAccessGrantDocMock.mockResolvedValue({ role: "partnership_manager", features: { finance: { view: true, actions: { approve_payables: false } } } });
    getSensitiveAccessGrantDocMock.mockResolvedValue(null);
    // Override: explicitly allow approve_payables, but also explicitly deny the module itself.
    getUserAccessOverrideDocMock.mockResolvedValue({
      uid: "uid-2",
      version: 1,
      features: { finance: { view: false, actions: { approve_payables: true } } },
    });

    const result = await getEffectiveAccess(actor, "ref-2");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.modules.finance.effective.value).toBe(false); // module denied
    // The action override itself is recorded independently...
    expect(result.data.modules.finance.actions.approve_payables?.override).toBe("allow");
    // ...but cannot make the module usable: effective action access is false.
    expect(result.data.modules.finance.actions.approve_payables?.effective.value).toBe(false);
  });

  it("resetting to inherit restores the role's own behavior", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    getActorScopeGrantsMock.mockResolvedValue([]);
    getAccessGrantDocMock.mockResolvedValue({ role: "partnership_manager", features: { partners: { view: true, actions: {} } } });
    getSensitiveAccessGrantDocMock.mockResolvedValue(null);
    // No override entry for partners at all (as if reset was already applied).
    getUserAccessOverrideDocMock.mockResolvedValue({ uid: "uid-2", version: 2, features: {} });

    const result = await getEffectiveAccess(actor, "ref-2");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.modules.partners.override).toBe("inherit");
    expect(result.data.modules.partners.effective).toEqual({ value: true, source: "role" });
  });

  it("defaults to empty baseline/overrides when the role has no access-grant or sensitive-grant document yet", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue({ ...targetDoc, role: "viewer" });
    getActorScopeGrantsMock.mockResolvedValue([]);
    getAccessGrantDocMock.mockResolvedValue(null);
    getSensitiveAccessGrantDocMock.mockResolvedValue(null);
    getUserAccessOverrideDocMock.mockResolvedValue(null);

    const result = await getEffectiveAccess(actor, "ref-2");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.activeFeatures).toEqual([]);
    expect(result.data.sensitiveCategories).toEqual([]);
    expect(result.data.modules.dashboard.effective).toEqual({ value: false, source: "role" });
  });
});
