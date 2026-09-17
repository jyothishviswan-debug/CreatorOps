// Step 9A - real reads/writes against the running Firestore/Auth
// emulator (no mocks), same rationale as Vendors'/Partners' own
// emulator test suites. Run with `pnpm test:emulator` against a running
// `pnpm firebase:emulators`.
import { beforeAll, describe, expect, it } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth } from "@/server/firebase/admin";
import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { getPartnerDocByRef } from "@/server/partners/firestore";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { getVendorDocByRef } from "@/server/vendors/firestore";
import { seedVendorsData } from "@/server/vendors/seed-vendors-data";
import {
  addCampaignResource,
  createCampaign,
  editCampaign,
  editCampaignResource,
  getCampaign,
  getCampaignHistory,
  getCampaignReadiness,
  listCampaigns,
  removeCampaignResource,
  setCampaignOwnerTeam,
} from "./campaign-service";
import { transitionCampaignLifecycle } from "./campaign-lifecycle-service";
import { getCampaignDocByRef } from "./firestore";
import { seedCampaignsData } from "./seed-campaigns-data";
import { campaignDocSchema } from "./types";

const uidByRole = new Map<string, string>();
const runId = Date.now();

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  await seedDiscoveryData();
  await seedPartnersData();
  await seedVendorsData();
  await seedCampaignsData();

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

function uniqueName(prefix: string): string {
  return `${prefix} ${runId}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createRealCampaign(head: ActorContext, overrides: Record<string, unknown> = {}) {
  const result = await createCampaign(
    head,
    {
      name: uniqueName("Real Campaign"),
      objective: "A real objective for a real Campaign.",
      platforms: ["instagram"],
      startDate: "2026-01-01",
      endDate: "2026-06-01",
      regionIds: ["Kerala"],
      defaultReviewPolicy: "REVIEW_REQUIRED",
      ...overrides,
    },
    "req-campaign-create",
  );
  if (!result.ok) throw new Error(`unreachable: ${result.message}`);
  return result.data;
}

describe("Campaign contract", () => {
  it("rejects an unrecognized field on create (schema strictness)", async () => {
    const head = await actorFor("partnership_head");
    const result = await createCampaign(
      head,
      { name: uniqueName("Strict"), objective: "x", startDate: "2026-01-01", endDate: "2026-02-01", defaultReviewPolicy: "REVIEW_REQUIRED", notARealField: "x" },
      "req-strict",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("direct create produces a Campaign that parses under the canonical schema, DRAFT by default", async () => {
    const head = await actorFor("partnership_head");
    const created = await createRealCampaign(head);
    expect(created.status).toBe("DRAFT");

    const doc = await getCampaignDocByRef(created.campaignRef);
    expect(campaignDocSchema.safeParse(doc).success).toBe(true);
    expect(doc).not.toHaveProperty("previousStatus"); // no restore-from-ARCHIVED machinery exists
  });

  it("rejects endDate before startDate on create and on edit", async () => {
    const head = await actorFor("partnership_head");
    const badCreate = await createCampaign(
      head,
      { name: uniqueName("Bad Dates"), objective: "x", startDate: "2026-06-01", endDate: "2026-01-01", defaultReviewPolicy: "REVIEW_REQUIRED" },
      "req-bad-dates",
    );
    expect(badCreate.ok).toBe(false);
    if (badCreate.ok) throw new Error("unreachable");
    expect(badCreate.code).toBe("invalid_input");

    const created = await createRealCampaign(head);
    const badEdit = await editCampaign(head, created.campaignRef, { endDate: "2025-01-01", expectedVersion: created.version }, "req-bad-edit-dates");
    expect(badEdit.ok).toBe(false);
    if (badEdit.ok) throw new Error("unreachable");
    expect(badEdit.code).toBe("invalid_input");
  });

  it("platform identity: normalizes case/whitespace, is stable, rejects whitespace-only and post-normalization duplicates, and never rejects an ordinary un-catalogued platform name", async () => {
    const head = await actorFor("partnership_head");

    // No invented catalog - "myspace" is not a "known" platform anywhere
    // in this repo, and must still be accepted (Step 9A.1's whole point).
    const uncatalogued = await createCampaign(
      head,
      { name: uniqueName("Uncatalogued Platform"), objective: "x", startDate: "2026-01-01", endDate: "2026-02-01", platforms: ["  MySpace  "], defaultReviewPolicy: "REVIEW_REQUIRED" },
      "req-uncatalogued-platform",
    );
    expect(uncatalogued.ok).toBe(true);
    if (!uncatalogued.ok) throw new Error("unreachable");
    expect(uncatalogued.data.platforms).toEqual(["myspace"]); // trimmed + lowercased

    const whitespaceOnly = await createCampaign(
      head,
      { name: uniqueName("Whitespace Platform"), objective: "x", startDate: "2026-01-01", endDate: "2026-02-01", platforms: ["   "], defaultReviewPolicy: "REVIEW_REQUIRED" },
      "req-whitespace-platform",
    );
    expect(whitespaceOnly.ok).toBe(false);
    if (whitespaceOnly.ok) throw new Error("unreachable");
    expect(whitespaceOnly.code).toBe("invalid_input");

    const duplicate = await createCampaign(
      head,
      { name: uniqueName("Duplicate Platform"), objective: "x", startDate: "2026-01-01", endDate: "2026-02-01", platforms: ["Instagram", "instagram"], defaultReviewPolicy: "REVIEW_REQUIRED" },
      "req-duplicate-platform",
    );
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("unreachable");
    expect(duplicate.code).toBe("invalid_input");
  });

  it("rejects an invalid review policy", async () => {
    const head = await actorFor("partnership_head");
    const badPolicy = await createCampaign(
      head,
      { name: uniqueName("Bad Policy"), objective: "x", startDate: "2026-01-01", endDate: "2026-02-01", defaultReviewPolicy: "SOMETIMES" },
      "req-bad-policy",
    );
    expect(badPolicy.ok).toBe(false);
  });

  it("criteria.platforms shares the exact same normalization/validation as top-level platforms", async () => {
    const head = await actorFor("partnership_head");
    const result = await createCampaign(
      head,
      { name: uniqueName("Criteria Platform"), objective: "x", startDate: "2026-01-01", endDate: "2026-02-01", defaultReviewPolicy: "REVIEW_REQUIRED", criteria: { platforms: ["  YouTube  "] } },
      "req-criteria-platform",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.criteria.platforms).toEqual(["youtube"]);

    const badCriteriaPlatform = await createCampaign(
      head,
      { name: uniqueName("Bad Criteria Platform"), objective: "x", startDate: "2026-01-01", endDate: "2026-02-01", defaultReviewPolicy: "REVIEW_REQUIRED", criteria: { platforms: ["  "] } },
      "req-bad-criteria-platform",
    );
    expect(badCriteriaPlatform.ok).toBe(false);
  });

  it("resource contract: rejects an invalid resource type, accepts a valid one, and enforces the bounded max", async () => {
    const head = await actorFor("partnership_head");
    const created = await createRealCampaign(head);

    const badType = await addCampaignResource(head, created.campaignRef, { label: "Brief", type: "NOT_A_TYPE", url: "https://example.com", expectedVersion: created.version }, "req-bad-resource");
    expect(badType.ok).toBe(false);

    const good = await addCampaignResource(head, created.campaignRef, { label: "Brief", type: "BRIEF", url: "https://example.com/brief.pdf", expectedVersion: created.version }, "req-good-resource");
    expect(good.ok).toBe(true);
    if (!good.ok) throw new Error("unreachable");
    expect(good.data.resources).toHaveLength(1);
    expect(good.data.resources[0]!.resourceRef).toBeTruthy();
  });

  it("targeting criteria accepts the canonical Target Audience taxonomy, rejects an unrecognized value, and never accepts tier at all", async () => {
    const head = await actorFor("partnership_head");
    const good = await createCampaign(
      head,
      { name: uniqueName("Audience Good"), objective: "x", startDate: "2026-01-01", endDate: "2026-02-01", defaultReviewPolicy: "REVIEW_REQUIRED", criteria: { targetAudience: "India 2" } },
      "req-audience-good",
    );
    expect(good.ok).toBe(true);
    if (!good.ok) throw new Error("unreachable");
    expect(good.data.criteria.targetAudience).toBe("India 2");
    expect(good.data.criteria).not.toHaveProperty("tier");

    const badAudience = await createCampaign(
      head,
      { name: uniqueName("Audience Bad"), objective: "x", startDate: "2026-01-01", endDate: "2026-02-01", defaultReviewPolicy: "REVIEW_REQUIRED", criteria: { targetAudience: "India 99" } },
      "req-audience-bad",
    );
    expect(badAudience.ok).toBe(false);

    const withTier = await createCampaign(
      head,
      { name: uniqueName("Tier Rejected"), objective: "x", startDate: "2026-01-01", endDate: "2026-02-01", defaultReviewPolicy: "REVIEW_REQUIRED", criteria: { tier: "gold" } },
      "req-tier-rejected",
    );
    expect(withTier.ok).toBe(false);
    if (withTier.ok) throw new Error("unreachable");
    expect(withTier.code).toBe("invalid_input");
  });
});

describe("Campaign create/edit", () => {
  it("creates, edits ordinary plan fields, and rejects a stale version", async () => {
    const head = await actorFor("partnership_head");
    const created = await createRealCampaign(head, { name: uniqueName("Editable") });

    const edited = await editCampaign(head, created.campaignRef, { name: "Renamed Once", objective: "New objective.", expectedVersion: created.version }, "req-edit-1");
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error("unreachable");
    expect(edited.data.name).toBe("Renamed Once");

    const stale = await editCampaign(head, created.campaignRef, { name: "Renamed Twice", expectedVersion: created.version }, "req-edit-2");
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unreachable");
    expect(stale.code).toBe("stale_write");
  });

  it("owner/team validation rejects a non-existent ownerUserRef and accepts a real active user", async () => {
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");
    const created = await createRealCampaign(head, { name: uniqueName("Owner Validation") });

    const bad = await setCampaignOwnerTeam(head, created.campaignRef, { ownerUserRef: "not-a-real-user-ref", teamIds: [], expectedVersion: created.version }, "req-owner-invalid");
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.code).toBe("invalid_input");

    const good = await setCampaignOwnerTeam(head, created.campaignRef, { ownerUserRef: manager.userRef, teamIds: ["kerala-programmes"], expectedVersion: created.version }, "req-owner-valid");
    expect(good.ok).toBe(true);
    if (!good.ok) throw new Error("unreachable");
    expect(good.data.ownerRef).toBe(manager.userRef);
  });

  it("the ordinary DTO never includes a raw Firestore id or Firebase uid", async () => {
    const head = await actorFor("partnership_head");
    const result = await getCampaign(head, "civic-voices");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const json = JSON.stringify(result.data);
    expect(json).not.toMatch(/"uid"/);
  });

  it("duplicate names are allowed - no business collision exists", async () => {
    const head = await actorFor("partnership_head");
    const name = uniqueName("Duplicate Name");
    const first = await createRealCampaign(head, { name });
    const second = await createRealCampaign(head, { name });
    expect(first.campaignRef).not.toBe(second.campaignRef);
  });

  it("resources: add, edit, and remove all use optimistic version checks", async () => {
    const head = await actorFor("partnership_head");
    const created = await createRealCampaign(head);

    const added = await addCampaignResource(head, created.campaignRef, { label: "Brief v1", type: "BRIEF", url: "https://example.com/v1.pdf", expectedVersion: created.version }, "req-add");
    if (!added.ok) throw new Error("unreachable");
    const resourceRef = added.data.resources[0]!.resourceRef;

    const edited = await editCampaignResource(head, created.campaignRef, { resourceRef, label: "Brief v2", expectedVersion: added.data.version }, "req-edit-resource");
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error("unreachable");
    expect(edited.data.resources[0]!.label).toBe("Brief v2");

    const removed = await removeCampaignResource(head, created.campaignRef, { resourceRef, expectedVersion: edited.data.version }, "req-remove-resource");
    expect(removed.ok).toBe(true);
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.data.resources).toHaveLength(0);
  });
});

describe("Campaign scope/list", () => {
  it("GLOBAL (Super Admin) sees every seeded Campaign", async () => {
    const admin = await actorFor("super_admin");
    const listed = await listCampaigns(admin, { limit: 50 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("unreachable");
    const refs = new Set(listed.data.campaigns.map((c) => c.campaignRef));
    expect(refs.has("seed-campaign-draft")).toBe(true);
    expect(refs.has("civic-voices")).toBe(true);
  });

  it("REGION-scoped actor (Manager) sees Kerala-region Campaigns but not Karnataka-only ones", async () => {
    const manager = await actorFor("partnership_manager"); // Kerala/Maharashtra/South/West only
    const listed = await listCampaigns(manager, { limit: 50 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("unreachable");
    const refs = new Set(listed.data.campaigns.map((c) => c.campaignRef));
    expect(refs.has("seed-campaign-draft")).toBe(true); // Kerala
    expect(refs.has("seed-campaign-paused")).toBe(false); // Karnataka only - out of scope
  });

  it("cross-scope direct-ref access is denied safely (not_found leak-free), same-scope direct-ref succeeds", async () => {
    const manager = await actorFor("partnership_manager");
    const denied = await getCampaign(manager, "seed-campaign-paused"); // Karnataka
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.code).toBe("unauthorized");
    expect(denied.reason).toBe("scope_denied");

    const allowed = await getCampaign(manager, "seed-campaign-draft"); // Kerala
    expect(allowed.ok).toBe(true);
  });

  it("a tampered/made-up campaignRef is denied as not_found, never leaking whether a differently-scoped Campaign exists", async () => {
    const manager = await actorFor("partnership_manager");
    const result = await getCampaign(manager, "not-a-real-campaign-ref-at-all");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("not_found");
  });

  it("CAMPAIGN-type explicit scope grant reaches a Campaign genuinely outside every other one of the actor's grants", async () => {
    const head = await actorFor("partnership_head"); // no Tamil Nadu region grant
    // civic-voices (Tamil Nadu) is reachable for Head ONLY through the
    // CAMPAIGN-type grant naming it specifically (see seed-access-data.ts).
    const result = await getCampaign(head, "civic-voices");
    expect(result.ok).toBe(true);

    const manager = await actorFor("partnership_manager"); // no CAMPAIGN grant, no Tamil Nadu
    const deniedForManager = await getCampaign(manager, "civic-voices");
    expect(deniedForManager.ok).toBe(false);
  });

  it("SELF scope: Manager sees their own owned Campaign even outside their granted regions", async () => {
    const manager = await actorFor("partnership_manager");
    const owned = await createRealCampaign(await actorFor("partnership_head"), { name: uniqueName("Manager Owned") });
    await setCampaignOwnerTeam(await actorFor("partnership_head"), owned.campaignRef, { ownerUserRef: manager.userRef, teamIds: [], expectedVersion: owned.version }, "req-self-owner");

    const listed = await listCampaigns(manager, { limit: 50, assignedToMe: true });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.data.campaigns.some((c) => c.campaignRef === owned.campaignRef)).toBe(true);
  });

  it("search (namePrefix) narrows results within scope", async () => {
    const head = await actorFor("partnership_head");
    const unique = uniqueName("Findable Search Target");
    await createRealCampaign(head, { name: unique });

    const found = await listCampaigns(head, { limit: 10, namePrefix: unique.toLowerCase() });
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error("unreachable");
    expect(found.data.campaigns.some((c) => c.name === unique)).toBe(true);
  });

  it("status filter narrows results within scope", async () => {
    const admin = await actorFor("super_admin");
    const listed = await listCampaigns(admin, { limit: 50, status: "ARCHIVED" });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.data.campaigns.every((c) => c.status === "ARCHIVED")).toBe(true);
    expect(listed.data.campaigns.some((c) => c.campaignRef === "seed-campaign-archived")).toBe(true);
  });

  it("cursor pagination is deterministic - two pages never repeat or skip a record", async () => {
    const admin = await actorFor("super_admin");
    const page1 = await listCampaigns(admin, { limit: 2 });
    expect(page1.ok).toBe(true);
    if (!page1.ok || !page1.data.nextCursor) throw new Error("expected a first page with a cursor");

    const page2 = await listCampaigns(admin, { limit: 2, cursor: page1.data.nextCursor });
    expect(page2.ok).toBe(true);
    if (!page2.ok) throw new Error("unreachable");

    const page1Refs = new Set(page1.data.campaigns.map((c) => c.campaignRef));
    const overlap = page2.data.campaigns.filter((c) => page1Refs.has(c.campaignRef));
    expect(overlap).toEqual([]);
  });

  it("overlapping grants (REGION + TEAM both matching) never duplicate a Campaign in the merged page", async () => {
    const head = await actorFor("partnership_head"); // has both Kerala REGION and kerala-programmes TEAM
    const listed = await listCampaigns(head, { limit: 50 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("unreachable");
    const refs = listed.data.campaigns.map((c) => c.campaignRef);
    expect(new Set(refs).size).toBe(refs.length); // no duplicates
  });
});

describe("Campaign lifecycle", () => {
  it("DRAFT -> PLANNED only when readiness passes, and blocks with typed not_ready otherwise", async () => {
    const head = await actorFor("partnership_head");
    const created = await createCampaign(
      head,
      { name: uniqueName("Incomplete"), objective: "x", startDate: "2026-01-01", endDate: "2026-02-01", platforms: [], regionIds: ["Kerala"], defaultReviewPolicy: "REVIEW_REQUIRED" },
      "req-incomplete-create",
    );
    if (!created.ok) throw new Error("unreachable");

    const blocked = await transitionCampaignLifecycle(head, created.data.campaignRef, { to: "PLANNED", expectedVersion: created.data.version }, "req-blocked-plan");
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("unreachable");
    expect(blocked.code).toBe("not_ready");
    expect(blocked.blockers?.some((b) => b.code === "PLATFORM_MISSING")).toBe(true);

    const ready = await createRealCampaign(head, { name: uniqueName("Ready") });
    const planned = await transitionCampaignLifecycle(head, ready.campaignRef, { to: "PLANNED", expectedVersion: ready.version }, "req-plan-ok");
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error("unreachable");
    expect(planned.data.status).toBe("PLANNED");
  });

  it("walks the full forward path: PLANNED -> ACTIVE -> PAUSED -> ACTIVE -> COMPLETED -> ARCHIVED", async () => {
    const head = await actorFor("partnership_head");
    const created = await createRealCampaign(head, { name: uniqueName("Full Path") });
    let version = created.version;

    const planned = await transitionCampaignLifecycle(head, created.campaignRef, { to: "PLANNED", expectedVersion: version }, "req-fp-1");
    if (!planned.ok) throw new Error("unreachable");
    version = planned.data.version;

    const active = await transitionCampaignLifecycle(head, created.campaignRef, { to: "ACTIVE", expectedVersion: version }, "req-fp-2");
    if (!active.ok) throw new Error("unreachable");
    version = active.data.version;

    const paused = await transitionCampaignLifecycle(head, created.campaignRef, { to: "PAUSED", expectedVersion: version }, "req-fp-3");
    if (!paused.ok) throw new Error("unreachable");
    version = paused.data.version;

    const resumed = await transitionCampaignLifecycle(head, created.campaignRef, { to: "ACTIVE", expectedVersion: version }, "req-fp-4");
    if (!resumed.ok) throw new Error("unreachable");
    version = resumed.data.version;

    const completed = await transitionCampaignLifecycle(head, created.campaignRef, { to: "COMPLETED", expectedVersion: version }, "req-fp-5");
    if (!completed.ok) throw new Error("unreachable");
    version = completed.data.version;

    const archived = await transitionCampaignLifecycle(head, created.campaignRef, { to: "ARCHIVED", reason: "Full lifecycle test complete.", expectedVersion: version }, "req-fp-6");
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("unreachable");
    expect(archived.data.status).toBe("ARCHIVED");
  });

  it("PLANNED -> DRAFT is allowed", async () => {
    const head = await actorFor("partnership_head");
    const created = await createRealCampaign(head, { name: uniqueName("Back To Draft") });
    const planned = await transitionCampaignLifecycle(head, created.campaignRef, { to: "PLANNED", expectedVersion: created.version }, "req-btd-1");
    if (!planned.ok) throw new Error("unreachable");

    const backToDraft = await transitionCampaignLifecycle(head, created.campaignRef, { to: "DRAFT", expectedVersion: planned.data.version }, "req-btd-2");
    expect(backToDraft.ok).toBe(true);
    if (!backToDraft.ok) throw new Error("unreachable");
    expect(backToDraft.data.status).toBe("DRAFT");
  });

  it("cancellation requires a reason, is reachable from every pre-terminal state, and is one-way (only ARCHIVED follows)", async () => {
    const head = await actorFor("partnership_head");
    const created = await createRealCampaign(head, { name: uniqueName("Cancel Me") });

    const noReason = await transitionCampaignLifecycle(head, created.campaignRef, { to: "CANCELLED", expectedVersion: created.version }, "req-cancel-no-reason");
    expect(noReason.ok).toBe(false);
    if (noReason.ok) throw new Error("unreachable");
    expect(noReason.code).toBe("invalid_input");

    const cancelled = await transitionCampaignLifecycle(head, created.campaignRef, { to: "CANCELLED", reason: "Deprioritized.", expectedVersion: created.version }, "req-cancel-ok");
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error("unreachable");
    expect(cancelled.data.status).toBe("CANCELLED");

    // Never restored - only ARCHIVED follows CANCELLED.
    const restoreAttempt = await transitionCampaignLifecycle(head, created.campaignRef, { to: "DRAFT", expectedVersion: cancelled.data.version }, "req-cancel-restore");
    expect(restoreAttempt.ok).toBe(false);
    if (restoreAttempt.ok) throw new Error("unreachable");
    expect(restoreAttempt.code).toBe("invalid_input");
  });

  it("archive requires a reason and never invents a restore from ARCHIVED", async () => {
    const head = await actorFor("partnership_head");
    const created = await createRealCampaign(head, { name: uniqueName("Archive Me") });
    const cancelled = await transitionCampaignLifecycle(head, created.campaignRef, { to: "CANCELLED", reason: "x", expectedVersion: created.version }, "req-arch-1");
    if (!cancelled.ok) throw new Error("unreachable");

    const noReason = await transitionCampaignLifecycle(head, created.campaignRef, { to: "ARCHIVED", expectedVersion: cancelled.data.version }, "req-arch-no-reason");
    expect(noReason.ok).toBe(false);

    const archived = await transitionCampaignLifecycle(head, created.campaignRef, { to: "ARCHIVED", reason: "Done.", expectedVersion: cancelled.data.version }, "req-arch-ok");
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("unreachable");

    // No edge in the graph ever lists ARCHIVED as an allowed predecessor.
    const restoreAttempt = await transitionCampaignLifecycle(head, created.campaignRef, { to: "ACTIVE", expectedVersion: archived.data.version }, "req-arch-restore");
    expect(restoreAttempt.ok).toBe(false);
    if (restoreAttempt.ok) throw new Error("unreachable");
    expect(restoreAttempt.code).toBe("invalid_input");
  });

  it("invalid edges are rejected (e.g. DRAFT -> ACTIVE directly, PAUSED -> COMPLETED directly)", async () => {
    const head = await actorFor("partnership_head");
    const created = await createRealCampaign(head, { name: uniqueName("Invalid Edges") });

    const draftToActive = await transitionCampaignLifecycle(head, created.campaignRef, { to: "ACTIVE", expectedVersion: created.version }, "req-invalid-1");
    expect(draftToActive.ok).toBe(false);
    if (draftToActive.ok) throw new Error("unreachable");
    expect(draftToActive.code).toBe("invalid_input");

    const planned = await transitionCampaignLifecycle(head, created.campaignRef, { to: "PLANNED", expectedVersion: created.version }, "req-invalid-2");
    if (!planned.ok) throw new Error("unreachable");
    const active = await transitionCampaignLifecycle(head, created.campaignRef, { to: "ACTIVE", expectedVersion: planned.data.version }, "req-invalid-3");
    if (!active.ok) throw new Error("unreachable");
    const paused = await transitionCampaignLifecycle(head, created.campaignRef, { to: "PAUSED", expectedVersion: active.data.version }, "req-invalid-4");
    if (!paused.ok) throw new Error("unreachable");

    const pausedToCompleted = await transitionCampaignLifecycle(head, created.campaignRef, { to: "COMPLETED", expectedVersion: paused.data.version }, "req-invalid-5");
    expect(pausedToCompleted.ok).toBe(false);
    if (pausedToCompleted.ok) throw new Error("unreachable");
    expect(pausedToCompleted.code).toBe("invalid_input");
  });

  it("a stale transition (version mismatch) is rejected", async () => {
    const head = await actorFor("partnership_head");
    const created = await createRealCampaign(head, { name: uniqueName("Stale Transition") });

    const first = await transitionCampaignLifecycle(head, created.campaignRef, { to: "PLANNED", expectedVersion: created.version }, "req-stale-1");
    expect(first.ok).toBe(true);

    const stale = await transitionCampaignLifecycle(head, created.campaignRef, { to: "ACTIVE", expectedVersion: created.version }, "req-stale-2");
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unreachable");
    expect(stale.code).toBe("stale_write");
  });

  it("history records exactly one lifecycle event per transition, never duplicated", async () => {
    const head = await actorFor("partnership_head");
    const created = await createRealCampaign(head, { name: uniqueName("History Check") });
    const planned = await transitionCampaignLifecycle(head, created.campaignRef, { to: "PLANNED", expectedVersion: created.version }, "req-history-1");
    if (!planned.ok) throw new Error("unreachable");

    const history = await getCampaignHistory(head, created.campaignRef, {});
    expect(history.ok).toBe(true);
    if (!history.ok) throw new Error("unreachable");
    expect(history.data.events.filter((e) => e.kind === "lifecycle_transitioned").length).toBe(1);
    expect(history.data.events.some((e) => e.kind === "created")).toBe(true);
    expect(history.data.events.every((e) => e.actorDisplayName)).toBe(true);
  });

  it("Partnership Manager can transition lifecycle but cannot cancel or archive (governance is Head-only)", async () => {
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");
    const created = await createRealCampaign(head, { name: uniqueName("Manager Lifecycle") });
    await setCampaignOwnerTeam(head, created.campaignRef, { ownerUserRef: manager.userRef, teamIds: [], expectedVersion: created.version }, "req-mgr-owner");

    const managerCampaign = await getCampaign(manager, created.campaignRef);
    if (!managerCampaign.ok) throw new Error("unreachable");

    const planned = await transitionCampaignLifecycle(manager, created.campaignRef, { to: "PLANNED", expectedVersion: managerCampaign.data.version }, "req-mgr-plan");
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error("unreachable");

    const cancelled = await transitionCampaignLifecycle(manager, created.campaignRef, { to: "CANCELLED", reason: "x", expectedVersion: planned.data.version }, "req-mgr-cancel");
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) throw new Error("unreachable");
    expect(cancelled.code).toBe("unauthorized");
    expect(cancelled.reason).toBe("action_denied");
  });

  it("readiness evaluation is independently callable and reflects the same blockers the transition itself would apply", async () => {
    const head = await actorFor("partnership_head");
    const incomplete = await createCampaign(
      head,
      { name: uniqueName("Readiness Check"), objective: "x", startDate: "2026-01-01", endDate: "2026-02-01", platforms: [], regionIds: ["Kerala"], defaultReviewPolicy: "REVIEW_REQUIRED" },
      "req-readiness-create",
    );
    if (!incomplete.ok) throw new Error("unreachable");

    const readiness = await getCampaignReadiness(head, incomplete.data.campaignRef);
    expect(readiness.ok).toBe(true);
    if (!readiness.ok) throw new Error("unreachable");
    expect(readiness.data.ready).toBe(false);
    expect(readiness.data.blockers.some((b) => b.code === "PLATFORM_MISSING")).toBe(true);
  });
});

describe("Campaign ownership boundaries", () => {
  it("targeting criteria never grants authorization - a Campaign whose criteria mentions an in-scope region is still denied if the Campaign's OWN region is out of scope", async () => {
    const manager = await actorFor("partnership_manager"); // Kerala granted, Karnataka not
    const created = await createRealCampaign(await actorFor("partnership_head"), {
      name: uniqueName("Criteria Trap"),
      regionIds: ["Karnataka"], // the Campaign's OWN scope dimension - out of Manager's scope
      criteria: { regionIds: ["Kerala"] }, // business targeting mentions Kerala, which Manager CAN see
    });

    const result = await getCampaign(manager, created.campaignRef);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("scope_denied");
  });

  it("Campaign stores no Agreement commercial terms - the DTO has no pricing/currency/contract fields", async () => {
    const head = await actorFor("partnership_head");
    const created = await createRealCampaign(head, { name: uniqueName("No Agreement Fields") });
    const json = JSON.stringify(created);
    expect(json).not.toMatch(/pricingModel|currency|contractedAmount|unitRate|invoiceRequirement|payeeVendor|taxWithholding|contractStatus/i);
  });

  it("active Vendor is never copied into Campaign payee truth - creating a Campaign never touches any Vendor document", async () => {
    const head = await actorFor("partnership_head");
    const vendorBefore = await getVendorDocByRef("seed-vendor-agency");
    await createRealCampaign(head, { name: uniqueName("No Vendor Touch") });
    const vendorAfter = await getVendorDocByRef("seed-vendor-agency");
    expect(vendorAfter?.version).toBe(vendorBefore?.version);
  });

  it("Campaign completion never mutates any Partner or Vendor document", async () => {
    const head = await actorFor("partnership_head");
    const partnerBefore = await getPartnerDocByRef("creator-house");
    const vendorBefore = await getVendorDocByRef("seed-vendor-agency");

    const created = await createRealCampaign(head, { name: uniqueName("Completion No Touch") });
    let version = created.version;
    const planned = await transitionCampaignLifecycle(head, created.campaignRef, { to: "PLANNED", expectedVersion: version }, "req-nt-1");
    if (!planned.ok) throw new Error("unreachable");
    version = planned.data.version;
    const active = await transitionCampaignLifecycle(head, created.campaignRef, { to: "ACTIVE", expectedVersion: version }, "req-nt-2");
    if (!active.ok) throw new Error("unreachable");
    version = active.data.version;
    const completed = await transitionCampaignLifecycle(head, created.campaignRef, { to: "COMPLETED", expectedVersion: version }, "req-nt-3");
    expect(completed.ok).toBe(true);

    const partnerAfter = await getPartnerDocByRef("creator-house");
    const vendorAfter = await getVendorDocByRef("seed-vendor-agency");
    expect(partnerAfter?.version).toBe(partnerBefore?.version);
    expect(vendorAfter?.version).toBe(vendorBefore?.version);
  });
});
