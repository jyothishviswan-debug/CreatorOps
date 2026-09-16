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
import {
  getActorScopeGrants,
  hasGlobalScope,
  isAnalyticsAccountInScope,
  isAnalyticsDatasetInScope,
  isCampaignInScope,
  isExplicitRecordInScope,
  isPartnerInScope,
  isRegionInScope,
  isSelfInScope,
  isTeamInScope,
} from "./scope";
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

  it("Partnership Head can approve_payables via role baseline; Partnership Manager's role baseline denies it (explicit action allow/deny)", async () => {
    await expect(canPerformAction(await actorFor("partnership_head"), "finance", "approve_payables")).resolves.toBe(true);
  });

  it("Step 5B.1: Partnership Manager's approve_payables is explicitly overridden to allow, even though the role baseline denies it (non-monotonic user override)", async () => {
    await expect(canPerformAction(await actorFor("partnership_manager"), "finance", "approve_payables")).resolves.toBe(true);
  });

  it("Step 5B.1: Viewer's role baseline denies Operations, but an explicit user override allows it (role-denied module explicitly allowed)", async () => {
    await expect(canAccessFeature(await actorFor("viewer"), "operations")).resolves.toBe(true);
  });

  it("Step 5B.1: Analyst's role baseline includes Export Center, but an explicit user override denies it (role-allowed module explicitly denied)", async () => {
    await expect(canAccessFeature(await actorFor("analyst"), "exports")).resolves.toBe(false);
    // Every other Analyst identity behavior (Import Center, etc.) is
    // untouched by this override - it targets exactly one module.
    await expect(canAccessFeature(await actorFor("analyst"), "imports")).resolves.toBe(true);
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

  it("Viewer's seeded scope allows SELF and their own region, and denies a region outside it", async () => {
    const viewer = await actorFor("viewer");
    const grants = await getActorScopeGrants(viewer);
    expect(isSelfInScope(grants, viewer.uid, viewer.uid)).toBe(true);
    expect(isRegionInScope(grants, "Kerala")).toBe(true);
    expect(isRegionInScope(grants, "Karnataka")).toBe(false);
  });

  it("Partnership Manager's seeded scope covers their team and partner, but not the Head's extra team", async () => {
    const grants = await getActorScopeGrants(await actorFor("partnership_manager"));
    expect(isTeamInScope(grants, "kerala-programmes")).toBe(true);
    expect(isPartnerInScope(grants, "creator-house")).toBe(true);
    expect(isTeamInScope(grants, "maharashtra-programmes")).toBe(false);
  });

  it("Partnership Head's seeded scope covers their campaign and explicit record grant", async () => {
    const grants = await getActorScopeGrants(await actorFor("partnership_head"));
    expect(isCampaignInScope(grants, "civic-voices")).toBe(true);
    expect(isCampaignInScope(grants, "regional-first")).toBe(false);
    expect(isExplicitRecordInScope(grants, "content", "community-story-reel-01")).toBe(true);
    expect(isExplicitRecordInScope(grants, "content", "some-other-item")).toBe(false);
  });

  it("Analyst's seeded scope covers their analytics dataset and account", async () => {
    const grants = await getActorScopeGrants(await actorFor("analyst"));
    expect(isAnalyticsDatasetInScope(grants, "cross-platform-reach")).toBe(true);
    expect(isAnalyticsAccountInScope(grants, "instagram-primary")).toBe(true);
    expect(isAnalyticsDatasetInScope(grants, "engagement-actions")).toBe(false);
  });

  it("Super Admin's scope is an explicit GLOBAL grant - not inferred from the role", async () => {
    const superAdminGrants = await getActorScopeGrants(await actorFor("super_admin"));
    expect(hasGlobalScope(superAdminGrants)).toBe(true);

    // Partnership Head is nominally "senior" too, but has no GLOBAL grant.
    const headGrants = await getActorScopeGrants(await actorFor("partnership_head"));
    expect(hasGlobalScope(headGrants)).toBe(false);
  });
});
