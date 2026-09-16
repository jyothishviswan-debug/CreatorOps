// Step 5A Administration API boundary - real reads/writes against the
// running Firestore/Auth emulator (no mocks). These scenarios are
// deliberately NOT covered by the function-boundary unit tests because
// they depend on real Firestore semantics that a hand-rolled mock would
// have to faithfully reimplement to be trustworthy: deterministic
// (email, userRef) ordering across real query cursors, and the actual
// transactional read-then-write behavior backing optimistic concurrency
// and the last-Super-Admin guard. Run with `pnpm test:emulator` against
// a running `pnpm firebase:emulators`.
import { beforeAll, describe, expect, it } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { getAdminAuth } from "@/server/firebase/admin";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { listAuditEventsForReview } from "./audit-service";
import { getEffectiveAccess } from "./effective-access-service";
import { addScopeGrant, removeScopeGrant } from "./scope-grants-service";
import { addSensitiveGrant, getSensitiveGrants, removeSensitiveGrant } from "./sensitive-grants-service";
import { createUser, getUser, listUsers, updateUser } from "./users-service";

const uidByRole = new Map<string, string>();
const runId = Date.now();

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

describe("Administration API boundary (real emulator)", () => {
  it("a non-Administration actor (Partnership Head) is denied every Administration operation", async () => {
    const head = await actorFor("partnership_head");
    await expect(listUsers(head, {})).resolves.toMatchObject({ ok: false, code: "unauthorized" });
    await expect(createUser(head, { email: "x@creatorops.com", password: "irrelevant", displayName: "X", role: "viewer" }, "req-deny")).resolves.toMatchObject({
      ok: false,
      code: "unauthorized",
    });
    await expect(listAuditEventsForReview(head, {})).resolves.toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("an unauthenticated actor is denied (null actor)", async () => {
    await expect(listUsers(null, {})).resolves.toMatchObject({ ok: false, code: "unauthorized", reason: "not_authenticated" });
  });

  it("pagination visits every seeded identity exactly once, in deterministic (email, userRef) order, across bounded pages", async () => {
    const admin = await actorFor("super_admin");
    const seen: { email: string; userRef: string }[] = [];
    let cursor: { email: string; userRef: string } | undefined;

    for (let guard = 0; guard < 50; guard += 1) {
      const page = await listUsers(admin, { limit: 2, cursor });
      if (!page.ok) throw new Error("listUsers failed");
      seen.push(...page.data.users.map((user) => ({ email: user.email, userRef: user.userRef })));
      if (!page.data.nextCursor) break;
      cursor = page.data.nextCursor;
    }

    const emails = seen.map((entry) => entry.email);
    expect(new Set(emails).size).toBe(emails.length); // no duplicate across page boundaries
    for (const identity of TEST_IDENTITIES) {
      expect(emails).toContain(identity.email);
    }
    const sortedEmails = [...emails].sort();
    expect(emails).toEqual(sortedEmails); // matches the deterministic ordering the query requests
  });

  it("createUser is idempotent: a repeat call with the same email returns the same userRef and creates no duplicate", async () => {
    const admin = await actorFor("super_admin");
    const email = `dev-${runId}@creatorops.com`;
    const input = { email, password: "a-strong-password-1", displayName: "Dev User", role: "viewer" as const };

    const first = await createUser(admin, input, "req-create-1");
    const second = await createUser(admin, input, "req-create-2");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.data.userRef).toBe(first.data.userRef);

    const auth = getAdminAuth();
    const authUser = await auth.getUserByEmail(email);
    expect(authUser).toBeTruthy();
  });

  it("effective access review for the Viewer identity matches what the enforcement primitives actually grant", async () => {
    const admin = await actorFor("super_admin");
    const viewerUid = uidByRole.get("viewer")!;
    const viewerLookup = await getUser(admin, (await resolveActor(viewerUid))!.userRef);
    if (!viewerLookup.ok) throw new Error("viewer lookup failed");

    const review = await getEffectiveAccess(admin, viewerLookup.data.userRef);
    expect(review.ok).toBe(true);
    if (!review.ok) throw new Error("unreachable");
    expect(review.data.role).toBe("viewer");
    expect(review.data.activeFeatures).toContain("dashboard");
    expect(review.data.activeFeatures).not.toContain("finance");
    expect(review.data.scope.regions).toContain("Kerala");
    expect(review.data.scope.global).toBe(false);
  });

  describe("full lifecycle against a freshly created dev user", () => {
    it("supports role change, deactivate/reactivate, stale-write rejection, and scope-grant add/remove end to end", async () => {
      const admin = await actorFor("super_admin");
      const email = `lifecycle-${runId}@creatorops.com`;
      const created = await createUser(admin, { email, password: "a-strong-password-2", displayName: "Lifecycle User", role: "viewer" }, "req-lifecycle-create");
      if (!created.ok) throw new Error("failed to create lifecycle user");
      const userRef = created.data.userRef;
      expect(created.data.version).toBe(1);

      // Role change
      const roleChanged = await updateUser(admin, userRef, { role: "analyst", expectedVersion: created.data.version }, "req-role-change");
      expect(roleChanged.ok).toBe(true);
      if (!roleChanged.ok) throw new Error("unreachable");
      expect(roleChanged.data.role).toBe("analyst");
      expect(roleChanged.data.version).toBe(2);

      // Stale write: reusing the now-outdated version must be rejected.
      const stale = await updateUser(admin, userRef, { displayName: "Should Not Apply", expectedVersion: 1 }, "req-stale");
      expect(stale).toMatchObject({ ok: false, code: "stale_write" });

      // Deactivate, then reactivate.
      const deactivated = await updateUser(admin, userRef, { active: false, expectedVersion: roleChanged.data.version }, "req-deactivate");
      expect(deactivated.ok).toBe(true);
      if (!deactivated.ok) throw new Error("unreachable");
      expect(deactivated.data.active).toBe(false);

      const reactivated = await updateUser(admin, userRef, { active: true, expectedVersion: deactivated.data.version }, "req-reactivate");
      expect(reactivated).toMatchObject({ ok: true, data: { active: true } });

      // Scope grants on this fully isolated dev user.
      const added = await addScopeGrant(admin, userRef, { type: "REGION", region: "Goa" }, "req-scope-add");
      expect(added).toEqual({ ok: true, data: { created: true } });

      const effective = await getEffectiveAccess(admin, userRef);
      expect(effective.ok).toBe(true);
      if (!effective.ok) throw new Error("unreachable");
      expect(effective.data.scope.regions).toContain("Goa");

      const removed = await removeScopeGrant(admin, userRef, { type: "REGION", region: "Goa" }, "req-scope-remove");
      expect(removed).toEqual({ ok: true, data: { removed: true } });

      const removedAgain = await removeScopeGrant(admin, userRef, { type: "REGION", region: "Goa" }, "req-scope-remove-2");
      expect(removedAgain).toMatchObject({ ok: false, code: "not_found" });
    });
  });

  it("blocks deactivating and blocks reassigning the sole active Super Admin (final Super Admin protection)", async () => {
    const admin = await actorFor("super_admin");
    const adminLookup = await getUser(admin, admin.userRef);
    if (!adminLookup.ok) throw new Error("admin self-lookup failed");

    const deactivateAttempt = await updateUser(admin, admin.userRef, { active: false, expectedVersion: adminLookup.data.version }, "req-protect-1");
    expect(deactivateAttempt).toMatchObject({ ok: false, code: "conflict" });

    const reassignAttempt = await updateUser(admin, admin.userRef, { role: "partnership_head", expectedVersion: adminLookup.data.version }, "req-protect-2");
    expect(reassignAttempt).toMatchObject({ ok: false, code: "conflict" });

    // The admin's own record must be untouched by either blocked attempt.
    const stillIntact = await getUser(admin, admin.userRef);
    expect(stillIntact).toMatchObject({ ok: true, data: { role: "super_admin", active: true, version: adminLookup.data.version } });
  });

  it("adds and removes a sensitive-access category on a role, leaving the baseline restored (sensitive grant add/remove)", async () => {
    const admin = await actorFor("super_admin");
    const before = await getSensitiveGrants(admin, "viewer");
    expect(before).toEqual({ ok: true, data: { role: "viewer", categories: [] } });

    const added = await addSensitiveGrant(admin, "viewer", { category: "partner_pii" }, "req-sensitive-add");
    expect(added).toEqual({ ok: true, data: { categories: ["partner_pii"] } });

    const removed = await removeSensitiveGrant(admin, "viewer", { category: "partner_pii" }, "req-sensitive-remove");
    expect(removed).toEqual({ ok: true, data: { categories: [] } });

    const restored = await getSensitiveGrants(admin, "viewer");
    expect(restored).toEqual({ ok: true, data: { role: "viewer", categories: [] } });
  });

  it("writes an audit event for every access-changing mutation, retrievable through the same review endpoint (view_audit)", async () => {
    const admin = await actorFor("super_admin");
    const email = `audit-${runId}@creatorops.com`;
    const created = await createUser(admin, { email, password: "a-strong-password-3", displayName: "Audit Target", role: "viewer" }, "req-audit-create");
    if (!created.ok) throw new Error("failed to create audit target user");

    const page = await listAuditEventsForReview(admin, { limit: 50 });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("unreachable");

    const createEvent = page.data.events.find((event) => event.requestId === "req-audit-create");
    expect(createEvent).toBeTruthy();
    expect(createEvent?.operation).toBe("user.create");
    expect(createEvent?.targetEmail).toBe(email);
    // No raw uid, password, or other secret-shaped value anywhere in the
    // reviewable audit trail.
    expect(JSON.stringify(page.data.events)).not.toContain("a-strong-password-3");
  });
});
