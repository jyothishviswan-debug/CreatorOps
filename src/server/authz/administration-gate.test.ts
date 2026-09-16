import { afterEach, describe, expect, it, vi } from "vitest";

const { canAccessFeatureMock, canPerformActionMock, getActorScopeGrantsMock, hasGlobalScopeMock } = vi.hoisted(() => ({
  canAccessFeatureMock: vi.fn(),
  canPerformActionMock: vi.fn(),
  getActorScopeGrantsMock: vi.fn(),
  hasGlobalScopeMock: vi.fn(),
}));

vi.mock("./capabilities", () => ({
  canAccessFeature: canAccessFeatureMock,
  canPerformAction: canPerformActionMock,
}));

vi.mock("./scope", () => ({
  getActorScopeGrants: getActorScopeGrantsMock,
  hasGlobalScope: hasGlobalScopeMock,
}));

import { requireAdministrationAccess } from "./administration-gate";
import type { ActorContext } from "./types";

const actor: ActorContext = {
  uid: "uid-1",
  email: "admin@creatorops.com",
  role: "super_admin",
  displayName: "Admin",
  userRef: "ref-1",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("requireAdministrationAccess", () => {
  it("denies when there is no actor at all (not authenticated)", async () => {
    const result = await requireAdministrationAccess(null, "manage_users");
    expect(result).toEqual({ ok: false, reason: "not_authenticated" });
    expect(canAccessFeatureMock).not.toHaveBeenCalled();
  });

  it("denies when the actor lacks Administration feature access (unauthorized role/capability denied)", async () => {
    canAccessFeatureMock.mockResolvedValue(false);
    const result = await requireAdministrationAccess(actor, "manage_users");
    expect(result).toEqual({ ok: false, reason: "feature_denied" });
    expect(canPerformActionMock).not.toHaveBeenCalled();
  });

  it("denies when the actor has Administration feature access but not the specific action", async () => {
    canAccessFeatureMock.mockResolvedValue(true);
    canPerformActionMock.mockResolvedValue(false);
    const result = await requireAdministrationAccess(actor, "manage_scope");
    expect(result).toEqual({ ok: false, reason: "action_denied" });
    expect(canPerformActionMock).toHaveBeenCalledWith(actor, "administration", "manage_scope");
    expect(getActorScopeGrantsMock).not.toHaveBeenCalled();
  });

  it("denies a non-GLOBAL actor even with feature+action granted (non-GLOBAL Administration actor denied for system-wide mutation)", async () => {
    canAccessFeatureMock.mockResolvedValue(true);
    canPerformActionMock.mockResolvedValue(true);
    getActorScopeGrantsMock.mockResolvedValue([{ type: "REGION", region: "Kerala" }]);
    hasGlobalScopeMock.mockReturnValue(false);

    const result = await requireAdministrationAccess(actor, "manage_users");
    expect(result).toEqual({ ok: false, reason: "scope_denied" });
  });

  it("allows only when feature, action, and explicit GLOBAL scope are all present", async () => {
    canAccessFeatureMock.mockResolvedValue(true);
    canPerformActionMock.mockResolvedValue(true);
    getActorScopeGrantsMock.mockResolvedValue([{ type: "GLOBAL" }]);
    hasGlobalScopeMock.mockReturnValue(true);

    const result = await requireAdministrationAccess(actor, "manage_users");
    expect(result).toEqual({ ok: true });
  });
});
