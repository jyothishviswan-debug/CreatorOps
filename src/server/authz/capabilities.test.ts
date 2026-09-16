import { afterEach, describe, expect, it, vi } from "vitest";

const { getAdminFirestoreMock } = vi.hoisted(() => ({ getAdminFirestoreMock: vi.fn() }));
vi.mock("@/server/firebase/admin", () => ({ getAdminFirestore: getAdminFirestoreMock }));

import { makeFakeFirestore } from "./test-helpers/fake-firestore";
import { canAccessFeature, canPerformAction, getAllowedFeatures } from "./capabilities";
import type { ActorContext } from "./types";

function actor(role: ActorContext["role"]): ActorContext {
  return { uid: `uid-${role}`, email: `${role}@creatorops.com`, role, displayName: role };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("canAccessFeature", () => {
  it("allows a feature the role's grant document explicitly lists as viewable", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "accessGrants/viewer": { role: "viewer", features: { dashboard: { view: true, actions: {} } } },
      }),
    );
    await expect(canAccessFeature(actor("viewer"), "dashboard")).resolves.toBe(true);
  });

  it("denies a feature that's simply absent from the role's grant document", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "accessGrants/viewer": { role: "viewer", features: { dashboard: { view: true, actions: {} } } },
      }),
    );
    await expect(canAccessFeature(actor("viewer"), "finance")).resolves.toBe(false);
  });

  it("denies every feature when the role has no grant document at all", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({}));
    await expect(canAccessFeature(actor("viewer"), "dashboard")).resolves.toBe(false);
  });

  it("does not fall back to any role-rank comparison: a role with no explicit grant for a feature is denied even when a 'lower' role has it", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "accessGrants/analyst": { role: "analyst", features: { imports: { view: true, actions: {} } } },
        // partnership_head's own document simply doesn't mention imports -
        // there is no rank under which this role "obviously" inherits it.
        "accessGrants/partnership_head": { role: "partnership_head", features: { dashboard: { view: true, actions: {} } } },
      }),
    );
    await expect(canAccessFeature(actor("analyst"), "imports")).resolves.toBe(true);
    await expect(canAccessFeature(actor("partnership_head"), "imports")).resolves.toBe(false);
  });
});

describe("canPerformAction", () => {
  it("allows an action explicitly granted within a feature", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "accessGrants/partnership_head": { role: "partnership_head", features: { finance: { view: true, actions: { approve: true } } } },
      }),
    );
    await expect(canPerformAction(actor("partnership_head"), "finance", "approve")).resolves.toBe(true);
  });

  it("denies an action within a viewable feature when that action isn't granted", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "accessGrants/partnership_manager": { role: "partnership_manager", features: { finance: { view: true, actions: { approve: false } } } },
      }),
    );
    await expect(canAccessFeature(actor("partnership_manager"), "finance")).resolves.toBe(true);
    await expect(canPerformAction(actor("partnership_manager"), "finance", "approve")).resolves.toBe(false);
  });

  it("denies an action that's absent from the actions map, without defaulting to allow", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "accessGrants/partnership_manager": { role: "partnership_manager", features: { finance: { view: true, actions: {} } } },
      }),
    );
    await expect(canPerformAction(actor("partnership_manager"), "finance", "approve")).resolves.toBe(false);
  });
});

describe("getAllowedFeatures", () => {
  it("returns only the features the role's grant document marks viewable", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "accessGrants/viewer": {
          role: "viewer",
          features: { dashboard: { view: true, actions: {} }, finance: { view: false, actions: {} } },
        },
      }),
    );
    await expect(getAllowedFeatures(actor("viewer"))).resolves.toEqual(["dashboard"]);
  });
});
