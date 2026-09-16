import { afterEach, describe, expect, it, vi } from "vitest";

const { getAdminFirestoreMock } = vi.hoisted(() => ({ getAdminFirestoreMock: vi.fn() }));
vi.mock("@/server/firebase/admin", () => ({ getAdminFirestore: getAdminFirestoreMock }));

import { makeFakeFirestore } from "./test-helpers/fake-firestore";
import { getActorScope, isRecordInScope } from "./scope";
import type { ActorContext } from "./types";

const actor: ActorContext = { uid: "uid-1", email: "a@b.com", role: "partnership_manager", displayName: "A" };

afterEach(() => {
  vi.clearAllMocks();
});

describe("isRecordInScope (pure)", () => {
  it("allows a record whose region is within the actor's assigned regions (representative same-scope allow)", () => {
    expect(isRecordInScope({ uid: "uid-1", regions: ["Kerala", "Maharashtra"] }, "Kerala")).toBe(true);
  });

  it("denies a record whose region is outside the actor's assigned regions (representative cross-scope deny)", () => {
    expect(isRecordInScope({ uid: "uid-1", regions: ["Kerala", "Maharashtra"] }, "Karnataka")).toBe(false);
  });

  it("denies a record with no region at all", () => {
    expect(isRecordInScope({ uid: "uid-1", regions: ["Kerala"] }, "")).toBe(false);
  });
});

describe("getActorScope", () => {
  it("fails closed (null) when regions is the wrong type", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({ "scopeAssignments/uid-1": { uid: "uid-1", regions: "Kerala" } }));
    await expect(getActorScope(actor)).resolves.toBeNull();
  });

  it("fails closed (null) when the scope document is missing entirely", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({}));
    await expect(getActorScope(actor)).resolves.toBeNull();
  });

  it("resolves a valid scope document", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({ "scopeAssignments/uid-1": { uid: "uid-1", regions: ["Kerala"] } }));
    await expect(getActorScope(actor)).resolves.toEqual({ uid: "uid-1", regions: ["Kerala"] });
  });
});
