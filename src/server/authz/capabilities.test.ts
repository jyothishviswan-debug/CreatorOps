import { afterEach, describe, expect, it, vi } from "vitest";

const { getAdminFirestoreMock } = vi.hoisted(() => ({ getAdminFirestoreMock: vi.fn() }));
vi.mock("@/server/firebase/admin", () => ({ getAdminFirestore: getAdminFirestoreMock }));

import { makeFakeFirestore } from "./test-helpers/fake-firestore";
import { canAccessFeature, canPerformAction, getAllowedFeatures } from "./capabilities";
import type { ActorContext } from "./types";

function actor(role: ActorContext["role"]): ActorContext {
  return { uid: `uid-${role}`, email: `${role}@creatorops.com`, role, displayName: role, userRef: `ref-${role}` };
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

describe("Step 5B.1: user-specific overrides", () => {
  it("role allow + no override (inherit) => allow", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "accessGrants/viewer": { role: "viewer", features: { dashboard: { view: true, actions: {} } } },
      }),
    );
    await expect(canAccessFeature(actor("viewer"), "dashboard")).resolves.toBe(true);
  });

  it("role deny + no override (inherit) => deny", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({ "accessGrants/viewer": { role: "viewer", features: {} } }));
    await expect(canAccessFeature(actor("viewer"), "finance")).resolves.toBe(false);
  });

  it("role allow + explicit user deny => deny", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "accessGrants/viewer": { role: "viewer", features: { dashboard: { view: true, actions: {} } } },
        "userAccessOverrides/uid-viewer": { uid: "uid-viewer", version: 1, features: { dashboard: { view: false, actions: {} } } },
      }),
    );
    await expect(canAccessFeature(actor("viewer"), "dashboard")).resolves.toBe(false);
  });

  it("role deny + explicit user allow => allow", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "accessGrants/viewer": { role: "viewer", features: {} },
        "userAccessOverrides/uid-viewer": { uid: "uid-viewer", version: 1, features: { finance: { view: true, actions: {} } } },
      }),
    );
    await expect(canAccessFeature(actor("viewer"), "finance")).resolves.toBe(true);
  });

  it("an action override is independent of the module's own baseline value", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "accessGrants/partnership_manager": { role: "partnership_manager", features: { finance: { view: true, actions: { approve_payables: false } } } },
        "userAccessOverrides/uid-partnership_manager": {
          uid: "uid-partnership_manager",
          version: 1,
          features: { finance: { actions: { approve_payables: true } } },
        },
      }),
    );
    await expect(canPerformAction(actor("partnership_manager"), "finance", "approve_payables")).resolves.toBe(true);
    // The module's own view override is untouched - still inherits the role baseline (true).
    await expect(canAccessFeature(actor("partnership_manager"), "finance")).resolves.toBe(true);
  });

  it("resetting an override (no entry for that feature) restores the role's own behavior", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "accessGrants/viewer": { role: "viewer", features: { dashboard: { view: true, actions: {} } } },
        // An override document exists, but has no entry for "dashboard" at all.
        "userAccessOverrides/uid-viewer": { uid: "uid-viewer", version: 2, features: { finance: { view: true, actions: {} } } },
      }),
    );
    await expect(canAccessFeature(actor("viewer"), "dashboard")).resolves.toBe(true);
  });

  // Step 5B.1A: a malformed override document is its own third state, not
  // silently collapsed into "no overrides". A missing document still
  // means "inherit the role baseline" (see the next few tests); an
  // *existing but corrupt* one must deny outright for every
  // feature/action, even ones the role baseline would allow, since
  // otherwise a corrupt document could accidentally preserve access it
  // should never have been trusted to decide.
  describe("Step 5B.1A: malformed override document fails closed", () => {
    it("missing override doc + role allow => inherited allow", async () => {
      getAdminFirestoreMock.mockReturnValue(
        makeFakeFirestore({
          "accessGrants/viewer": { role: "viewer", features: { dashboard: { view: true, actions: {} } } },
          // No userAccessOverrides/uid-viewer document at all.
        }),
      );
      await expect(canAccessFeature(actor("viewer"), "dashboard")).resolves.toBe(true);
    });

    it("malformed override doc + role allow => deny", async () => {
      getAdminFirestoreMock.mockReturnValue(
        makeFakeFirestore({
          "accessGrants/viewer": { role: "viewer", features: { dashboard: { view: true, actions: {} } } },
          // Missing required `version` / wrong shape - fails schema validation.
          "userAccessOverrides/uid-viewer": { uid: "uid-viewer", features: {} },
        }),
      );
      await expect(canAccessFeature(actor("viewer"), "dashboard")).resolves.toBe(false);
    });

    it("malformed override doc + role deny => deny", async () => {
      getAdminFirestoreMock.mockReturnValue(
        makeFakeFirestore({
          "accessGrants/viewer": { role: "viewer", features: {} },
          "userAccessOverrides/uid-viewer": { uid: "uid-viewer", features: {} },
        }),
      );
      await expect(canAccessFeature(actor("viewer"), "finance")).resolves.toBe(false);
    });

    it("a malformed action override cannot widen access, even when it looks like an explicit allow", async () => {
      getAdminFirestoreMock.mockReturnValue(
        makeFakeFirestore({
          "accessGrants/partnership_manager": { role: "partnership_manager", features: { finance: { view: true, actions: { approve_payables: false } } } },
          // The document itself fails validation (missing version), even
          // though the `features` payload alone, if it parsed, would look
          // like a legitimate explicit allow of approve_payables.
          "userAccessOverrides/uid-partnership_manager": {
            uid: "uid-partnership_manager",
            features: { finance: { actions: { approve_payables: true } } },
          },
        }),
      );
      await expect(canPerformAction(actor("partnership_manager"), "finance", "approve_payables")).resolves.toBe(false);
      await expect(canAccessFeature(actor("partnership_manager"), "finance")).resolves.toBe(false);
    });

    it("the role's own real grants for OTHER actors are unaffected by one actor's malformed override doc", async () => {
      getAdminFirestoreMock.mockReturnValue(
        makeFakeFirestore({
          "accessGrants/viewer": { role: "viewer", features: { dashboard: { view: true, actions: {} } } },
          "userAccessOverrides/uid-viewer": { uid: "uid-viewer", features: {} },
        }),
      );
      // A second viewer with no override document of their own still inherits normally.
      await expect(canAccessFeature({ uid: "uid-other-viewer", email: "other@creatorops.com", role: "viewer", displayName: "Other Viewer", userRef: "ref-other" }, "dashboard")).resolves.toBe(
        true,
      );
    });
  });
});
