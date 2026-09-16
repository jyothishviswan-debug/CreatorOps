// Focused emulator tests: real reads against the running Firestore/Auth
// emulator (no mocks), proving the seeded access-control data produces
// the expected decisions end-to-end. Run with `pnpm test:emulator`
// against a running `pnpm firebase:emulators`.
import { beforeAll, describe, expect, it } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { getAdminAuth } from "@/server/firebase/admin";
import { resolveActor } from "./actor";
import { canAccessFeature, canPerformAction } from "./capabilities";
import { seedAccessControlData, TEST_IDENTITIES } from "./seed-access-data";
import { canAccessSensitive } from "./sensitive";
import { getActorScope, isRecordInScope } from "./scope";
import type { ActorContext } from "./types";

const uidByRole = new Map<string, string>();

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) {
    throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  }
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();

  const auth = getAdminAuth();
  for (const identity of TEST_IDENTITIES) {
    const user = await auth.getUserByEmail(identity.email);
    uidByRole.set(identity.role, user.uid);
  }
}, 30_000);

async function actorFor(role: string): Promise<ActorContext> {
  const uid = uidByRole.get(role);
  if (!uid) throw new Error(`No seeded uid for role ${role}`);
  const actor = await resolveActor(uid);
  if (!actor) throw new Error(`resolveActor returned null for seeded role ${role}`);
  return actor;
}

describe("seeded access-control data (real emulator)", () => {
  it("resolves every one of the five seeded identities as an active actor with the expected role", async () => {
    for (const identity of TEST_IDENTITIES) {
      const actor = await actorFor(identity.role);
      expect(actor.role).toBe(identity.role);
    }
  });

  it("Viewer is denied Finance; Partnership Manager is allowed Finance (explicit feature allow/deny)", async () => {
    await expect(canAccessFeature(await actorFor("viewer"), "finance")).resolves.toBe(false);
    await expect(canAccessFeature(await actorFor("partnership_manager"), "finance")).resolves.toBe(true);
  });

  it("Partnership Manager cannot approve Finance; Partnership Head can (explicit action allow/deny)", async () => {
    await expect(canPerformAction(await actorFor("partnership_manager"), "finance", "approve")).resolves.toBe(false);
    await expect(canPerformAction(await actorFor("partnership_head"), "finance", "approve")).resolves.toBe(true);
  });

  it("Analyst has Import Center; Partnership Head - otherwise broader - does not (no role-rank fallback)", async () => {
    await expect(canAccessFeature(await actorFor("analyst"), "imports")).resolves.toBe(true);
    await expect(canAccessFeature(await actorFor("partnership_head"), "imports")).resolves.toBe(false);
  });

  it("Partnership Head has sensitive finance_amounts access; Partnership Manager does not (sensitive-access allow/deny)", async () => {
    await expect(canAccessSensitive(await actorFor("partnership_head"), "finance_amounts")).resolves.toBe(true);
    await expect(canAccessSensitive(await actorFor("partnership_manager"), "finance_amounts")).resolves.toBe(false);
  });

  it("Super Admin's own grant explicitly covers Administration (explicit, not a rank comparison)", async () => {
    await expect(canAccessFeature(await actorFor("super_admin"), "administration")).resolves.toBe(true);
    await expect(canAccessFeature(await actorFor("partnership_head"), "administration")).resolves.toBe(false);
  });

  it("Viewer's seeded scope allows their own region and denies a region outside it", async () => {
    const scope = await getActorScope(await actorFor("viewer"));
    expect(scope).not.toBeNull();
    expect(isRecordInScope(scope!, "Kerala")).toBe(true);
    expect(isRecordInScope(scope!, "Karnataka")).toBe(false);
  });
});
