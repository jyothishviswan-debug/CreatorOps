import { afterEach, describe, expect, it, vi } from "vitest";

const { getAdminFirestoreMock } = vi.hoisted(() => ({ getAdminFirestoreMock: vi.fn() }));
vi.mock("@/server/firebase/admin", () => ({ getAdminFirestore: getAdminFirestoreMock }));

import { makeFakeFirestore } from "./test-helpers/fake-firestore";
import { canAccessSensitive } from "./sensitive";
import type { ActorContext } from "./types";

afterEach(() => {
  vi.clearAllMocks();
});

function actor(role: ActorContext["role"]): ActorContext {
  return { uid: `uid-${role}`, email: `${role}@creatorops.com`, role, displayName: role, userRef: `ref-${role}` };
}

describe("canAccessSensitive", () => {
  it("allows a category the role's grant explicitly lists (sensitive-access allow)", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({ "sensitiveAccessGrants/partnership_head": { role: "partnership_head", categories: ["finance_amounts"] } }),
    );
    await expect(canAccessSensitive(actor("partnership_head"), "finance_amounts")).resolves.toBe(true);
  });

  it("denies a category not listed, even though the role can view the surrounding feature (sensitive-access deny)", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({ "sensitiveAccessGrants/partnership_manager": { role: "partnership_manager", categories: [] } }),
    );
    await expect(canAccessSensitive(actor("partnership_manager"), "finance_amounts")).resolves.toBe(false);
  });

  it("fails closed when the grant document is missing", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({}));
    await expect(canAccessSensitive(actor("viewer"), "finance_amounts")).resolves.toBe(false);
  });
});
