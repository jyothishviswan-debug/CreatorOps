import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireAdministrationAccessMock,
  getUserDocByRefMock,
  getAllowedFeaturesMock,
  getActorScopeGrantsMock,
  getAccessGrantDocMock,
  getSensitiveAccessGrantDocMock,
} = vi.hoisted(() => ({
  requireAdministrationAccessMock: vi.fn(),
  getUserDocByRefMock: vi.fn(),
  getAllowedFeaturesMock: vi.fn(),
  getActorScopeGrantsMock: vi.fn(),
  getAccessGrantDocMock: vi.fn(),
  getSensitiveAccessGrantDocMock: vi.fn(),
}));

vi.mock("@/server/authz/administration-gate", () => ({ requireAdministrationAccess: requireAdministrationAccessMock }));
vi.mock("@/server/authz/capabilities", () => ({ getAllowedFeatures: getAllowedFeaturesMock }));
vi.mock("@/server/authz/scope", () => ({ getActorScopeGrants: getActorScopeGrantsMock }));
vi.mock("@/server/authz/firestore", () => ({
  getUserDocByRef: getUserDocByRefMock,
  getAccessGrantDoc: getAccessGrantDocMock,
  getSensitiveAccessGrantDoc: getSensitiveAccessGrantDocMock,
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

  it("resolves the review through the exact same primitives enforcement uses, run against the target user", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue(targetDoc);
    getAllowedFeaturesMock.mockResolvedValue(["dashboard", "partners"]);
    getActorScopeGrantsMock.mockResolvedValue([
      { type: "REGION", region: "Kerala", uid: "uid-2", grantedAt: "x", grantedBy: "uid-1" },
      { type: "PARTNER", partnerId: "partner-1", uid: "uid-2", grantedAt: "x", grantedBy: "uid-1" },
    ]);
    getAccessGrantDocMock.mockResolvedValue({
      role: "partnership_manager",
      features: { partners: { view: true, actions: { create: true } } },
    });
    getSensitiveAccessGrantDocMock.mockResolvedValue({ role: "partnership_manager", categories: ["finance_amounts"] });

    const result = await getEffectiveAccess(actor, "ref-2");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toEqual({
      userRef: "ref-2",
      role: "partnership_manager",
      active: true,
      activeFeatures: ["dashboard", "partners"],
      features: { partners: { view: true, actions: { create: true } } },
      scope: {
        global: false,
        self: false,
        regions: ["Kerala"],
        teams: [],
        partners: ["partner-1"],
        campaigns: [],
        analyticsDatasets: [],
        analyticsAccounts: [],
        explicitRecordCount: 0,
      },
      sensitiveCategories: ["finance_amounts"],
    });

    // Every primitive was evaluated against the *target* user, not the
    // reviewing actor - that's the whole point of an effective access
    // review.
    expect(getAllowedFeaturesMock).toHaveBeenCalledWith(expect.objectContaining({ uid: "uid-2", role: "partnership_manager" }));
    expect(getActorScopeGrantsMock).toHaveBeenCalledWith(expect.objectContaining({ uid: "uid-2" }));
  });

  it("defaults to empty grants when the role has no access-grant or sensitive-grant document yet", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getUserDocByRefMock.mockResolvedValue({ ...targetDoc, role: "viewer" });
    getAllowedFeaturesMock.mockResolvedValue([]);
    getActorScopeGrantsMock.mockResolvedValue([]);
    getAccessGrantDocMock.mockResolvedValue(null);
    getSensitiveAccessGrantDocMock.mockResolvedValue(null);

    const result = await getEffectiveAccess(actor, "ref-2");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.features).toEqual({});
    expect(result.data.sensitiveCategories).toEqual([]);
  });
});
