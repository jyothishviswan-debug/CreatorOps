import { afterEach, describe, expect, it, vi } from "vitest";

const { getAdminFirestoreMock } = vi.hoisted(() => ({ getAdminFirestoreMock: vi.fn() }));
vi.mock("@/server/firebase/admin", () => ({ getAdminFirestore: getAdminFirestoreMock }));

import { makeFakeFirestore } from "./test-helpers/fake-firestore";
import { getAccessGrantDoc, getScopeAssignmentDoc, getSensitiveAccessGrantDoc, getUserDoc } from "./firestore";

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

describe("getScopeAssignmentDoc", () => {
  it("fails closed when regions is the wrong type", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({ "scopeAssignments/uid-1": { uid: "uid-1", regions: "Kerala" } }));
    await expect(getScopeAssignmentDoc("uid-1")).resolves.toBeNull();
  });

  it("fails closed when regions is an empty array", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({ "scopeAssignments/uid-1": { uid: "uid-1", regions: [] } }));
    await expect(getScopeAssignmentDoc("uid-1")).resolves.toBeNull();
  });

  it("returns the parsed document when it's valid", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({ "scopeAssignments/uid-1": { uid: "uid-1", regions: ["Kerala"] } }));
    await expect(getScopeAssignmentDoc("uid-1")).resolves.toEqual({ uid: "uid-1", regions: ["Kerala"] });
  });
});

describe("getSensitiveAccessGrantDoc", () => {
  it("returns null for a missing document", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({}));
    await expect(getSensitiveAccessGrantDoc("viewer")).resolves.toBeNull();
  });
});
