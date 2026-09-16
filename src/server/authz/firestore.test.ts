import { afterEach, describe, expect, it, vi } from "vitest";

const { getAdminFirestoreMock } = vi.hoisted(() => ({ getAdminFirestoreMock: vi.fn() }));
vi.mock("@/server/firebase/admin", () => ({ getAdminFirestore: getAdminFirestoreMock }));

import { makeFakeFirestore } from "./test-helpers/fake-firestore";
import { getAccessGrantDoc, getActorScopeGrants, getSensitiveAccessGrantDoc, getUserDoc } from "./firestore";

afterEach(() => {
  vi.clearAllMocks();
});

describe("getUserDoc", () => {
  it("returns null for a document that doesn't exist (missing access profile)", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({}));
    await expect(getUserDoc("no-such-uid")).resolves.toBeNull();
  });

  it("returns null for a document that exists but doesn't parse (malformed access profile)", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "users/uid-1": { uid: "uid-1", email: "a@b.com", role: "not-a-real-role", active: true, displayName: "A" },
      }),
    );
    await expect(getUserDoc("uid-1")).resolves.toBeNull();
  });

  it("returns the parsed document when it's valid", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "users/uid-1": { uid: "uid-1", email: "a@b.com", role: "viewer", active: true, displayName: "A" },
      }),
    );
    await expect(getUserDoc("uid-1")).resolves.toEqual({
      uid: "uid-1",
      email: "a@b.com",
      role: "viewer",
      active: true,
      displayName: "A",
    });
  });
});

describe("getAccessGrantDoc", () => {
  it("fails closed when the features map contains an unrecognized feature id", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "accessGrants/viewer": { role: "viewer", features: { not_a_real_feature: { view: true, actions: {} } } },
      }),
    );
    await expect(getAccessGrantDoc("viewer")).resolves.toBeNull();
  });
});

describe("getActorScopeGrants", () => {
  it("returns an empty array when the actor has no grant documents", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({}));
    await expect(getActorScopeGrants("uid-1")).resolves.toEqual([]);
  });

  it("drops a grant document that doesn't parse (unrecognized type), without affecting other valid grants", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "scopeAssignments/uid-1__REGION__Kerala": {
          uid: "uid-1",
          type: "REGION",
          region: "Kerala",
          grantedAt: "2026-01-01T00:00:00.000Z",
          grantedBy: "system:seed",
        },
        "scopeAssignments/uid-1__WEIRD": { uid: "uid-1", type: "NOT_A_REAL_TYPE", grantedAt: "x", grantedBy: "y" },
      }),
    );
    const grants = await getActorScopeGrants("uid-1");
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ type: "REGION", region: "Kerala" });
  });

  it("only returns grants belonging to the requested uid", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "scopeAssignments/uid-1__GLOBAL": { uid: "uid-1", type: "GLOBAL", grantedAt: "x", grantedBy: "y" },
        "scopeAssignments/uid-2__GLOBAL": { uid: "uid-2", type: "GLOBAL", grantedAt: "x", grantedBy: "y" },
      }),
    );
    const grants = await getActorScopeGrants("uid-1");
    expect(grants).toHaveLength(1);
  });
});

describe("getSensitiveAccessGrantDoc", () => {
  it("returns null for a missing document", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({}));
    await expect(getSensitiveAccessGrantDoc("viewer")).resolves.toBeNull();
  });
});
