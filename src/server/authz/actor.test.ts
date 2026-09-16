import { afterEach, describe, expect, it, vi } from "vitest";

const { getAdminFirestoreMock } = vi.hoisted(() => ({ getAdminFirestoreMock: vi.fn() }));
vi.mock("@/server/firebase/admin", () => ({ getAdminFirestore: getAdminFirestoreMock }));

import { makeFakeFirestore } from "./test-helpers/fake-firestore";
import { resolveActor } from "./actor";

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveActor", () => {
  it("denies a user with no access profile document", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({}));
    await expect(resolveActor("uid-1")).resolves.toBeNull();
  });

  it("denies an inactive user, even with an otherwise valid profile", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "users/uid-1": { uid: "uid-1", email: "a@b.com", role: "viewer", active: false, displayName: "A" },
      }),
    );
    await expect(resolveActor("uid-1")).resolves.toBeNull();
  });

  it("denies a profile whose stored uid disagrees with the lookup key", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "users/uid-1": { uid: "someone-else", email: "a@b.com", role: "viewer", active: true, displayName: "A" },
      }),
    );
    await expect(resolveActor("uid-1")).resolves.toBeNull();
  });

  it("denies a malformed profile (bad role value)", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "users/uid-1": { uid: "uid-1", email: "a@b.com", role: "not-a-role", active: true, displayName: "A" },
      }),
    );
    await expect(resolveActor("uid-1")).resolves.toBeNull();
  });

  it("resolves a valid, active profile into an actor context", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "users/uid-1": {
          uid: "uid-1",
          email: "a@b.com",
          role: "viewer",
          active: true,
          displayName: "A",
          userRef: "ref-1",
          version: 1,
        },
      }),
    );
    await expect(resolveActor("uid-1")).resolves.toEqual({
      uid: "uid-1",
      email: "a@b.com",
      role: "viewer",
      displayName: "A",
      userRef: "ref-1",
    });
  });
});
