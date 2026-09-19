// Step 12C.2 - real reads/writes against the running Firestore/Auth
// emulator (no mocks of the service/data layer): the two Assignment
// integrity corrections.
//   1. createAssignment/createAssignmentWithOutcome require the actor's own
//      Partner Record Scope (requirePartnerInScope) - the scoped picker is
//      not an authorization boundary - and a denial writes NOTHING.
//   2. editAssignmentBrief re-applies the create-time Partner Account /
//      platform / resource-link invariants, and a rejected edit changes
//      nothing.
// Every test builds its OWN fresh Campaign/Partners (the (campaignRef,
// partnerRef) claim is permanent and other emulator files run in parallel),
// and every side-effect proof is scoped to this test's own records.
import { beforeAll, describe, expect, it, vi } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";

import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { seedVendorsData } from "@/server/vendors/seed-vendors-data";
import { seedCampaignsData } from "@/server/campaigns/seed-campaigns-data";
import { seedAssignmentsData } from "@/server/assignments/seed-assignments-data";
import { seedContentData } from "@/server/content/seed-content-data";
import { seedAnalyticsData } from "@/server/analytics/seed-analytics-data";

import { createCampaign } from "@/server/campaigns/campaign-service";
import { transitionCampaignLifecycle } from "@/server/campaigns/campaign-lifecycle-service";
import { createPartner } from "@/server/partners/partner-service";
import { createPartnerAccount, setPartnerAccountStatus } from "@/server/partners/partner-account-service";
import { createAssignment, createAssignmentWithOutcome, editAssignmentBrief } from "@/server/assignments/assignment-service";
import { assignmentActiveClaimDocId, assignmentActiveClaimsCollection, assignmentEventsCollection, assignmentsCollection } from "@/server/assignments/firestore";

// The direct HTTP path: POST /api/assignments runs the real route handler and
// the real service; only the session lookup is replaced so the test can name
// the actor (every other test file resolves actors the same way, by uid).
let httpActor: ActorContext | null = null;
vi.mock("@/server/administration/http", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/administration/http")>();
  return { ...original, resolveRequestActor: async () => httpActor };
});
import { POST as postAssignment } from "@/app/api/assignments/route";

const uidByRole = new Map<string, string>();
const runId = Date.now();
let counter = 0;

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  await seedDiscoveryData();
  await seedPartnersData();
  await seedVendorsData();
  await seedCampaignsData();
  await seedAssignmentsData();
  await seedContentData();
  await seedAnalyticsData();

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

function unique(prefix: string): string {
  counter += 1;
  return `${prefix} ${runId}-${counter}`;
}

async function createCampaignInState(actor: ActorContext, options: { regionIds?: string[]; platforms?: string[] } = {}): Promise<{ campaignRef: string }> {
  const created = await createCampaign(
    actor,
    { name: unique("Integrity Campaign"), objective: "Step 12C.2 emulator coverage.", platforms: options.platforms ?? ["instagram"], startDate: "2026-01-01", endDate: "2026-12-01", regionIds: options.regionIds ?? ["Kerala"], defaultReviewPolicy: "REVIEW_REQUIRED" },
    `req-${unique("create")}`,
  );
  if (!created.ok) throw new Error(`createCampaign failed: ${created.message}`);
  const planned = await transitionCampaignLifecycle(actor, created.data.campaignRef, { to: "PLANNED", expectedVersion: created.data.version }, `req-${unique("plan")}`);
  if (!planned.ok) throw new Error(`PLANNED failed: ${planned.message}`);
  return { campaignRef: created.data.campaignRef };
}

async function createPartnerWithAccounts(
  admin: ActorContext,
  accounts: Array<{ platform: string; handle: string; inactive?: boolean }>,
  regionIds: string[] = ["Kerala"],
): Promise<{ partnerRef: string; accountRefs: string[] }> {
  const partner = await createPartner(admin, { displayName: unique("Integrity Partner"), regionIds }, `req-${unique("partner")}`);
  if (!partner.ok) throw new Error(`createPartner failed: ${partner.message}`);
  const accountRefs: string[] = [];
  for (const account of accounts) {
    const created = await createPartnerAccount(admin, partner.data.partnerRef, { platform: account.platform, handle: `${account.handle}-${runId}-${++counter}` }, `req-${unique("account")}`);
    if (!created.ok) throw new Error(`createPartnerAccount failed: ${created.message}`);
    accountRefs.push(created.data.partnerAccountRef);
    if (account.inactive) {
      const off = await setPartnerAccountStatus(admin, created.data.partnerAccountRef, { status: "INACTIVE", expectedVersion: created.data.version }, `req-${unique("inactive")}`);
      if (!off.ok) throw new Error(`setPartnerAccountStatus failed: ${off.message}`);
    }
  }
  return { partnerRef: partner.data.partnerRef, accountRefs };
}

async function assignmentDocsFor(campaignRef: string) {
  return (await assignmentsCollection().where("campaignRef", "==", campaignRef).get()).docs;
}

// Everything a denied create could leave behind: an Assignment doc, its
// uniqueness claim doc, and any "created" event (events live under an
// Assignment doc, so also checked through the collection group by campaignRef).
async function writesFor(campaignRef: string, partnerRef: string) {
  const claim = await assignmentActiveClaimsCollection().doc(assignmentActiveClaimDocId(campaignRef, partnerRef)).get();
  const claimsForCampaign = await assignmentActiveClaimsCollection().where("campaignRef", "==", campaignRef).get();
  const events = await getAdminFirestore().collectionGroup("events").where("metadata.campaignRef", "==", campaignRef).get();
  return { assignmentDocs: (await assignmentDocsFor(campaignRef)).length, claimDocExists: claim.exists, claimsForCampaign: claimsForCampaign.size, events: events.size };
}

describe("Assignment create - server-side Partner Record Scope", () => {
  it("an in-scope Campaign + a Partner OUTSIDE the actor's scope is denied by BOTH create entry points, and nothing is written", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    // Manager holds Kerala (Campaign) but NOT Karnataka (Partner) - see seed-access-data.
    const campaign = await createCampaignInState(manager, { regionIds: ["Kerala"] });
    const outOfScopePartner = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: "outside" }], ["Karnataka"]);
    const input = { campaignRef: campaign.campaignRef, partnerRef: outOfScopePartner.partnerRef, partnerAccountRefs: outOfScopePartner.accountRefs, brief: { platforms: ["instagram"] } };
    const before = await writesFor(campaign.campaignRef, outOfScopePartner.partnerRef);
    expect(before).toEqual({ assignmentDocs: 0, claimDocExists: false, claimsForCampaign: 0, events: 0 });

    const outcome = await createAssignmentWithOutcome(manager, input, "req-scope-1");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("unauthorized");
    expect(outcome.reason).toBe("scope_denied");

    const legacy = await createAssignment(manager, input, "req-scope-2");
    expect(legacy.ok).toBe(false);
    if (legacy.ok) return;
    expect(legacy.code).toBe("unauthorized");
    expect(legacy.reason).toBe("scope_denied");

    // No Assignment doc, no uniqueness claim doc, no event - nothing partial.
    expect(await writesFor(campaign.campaignRef, outOfScopePartner.partnerRef)).toEqual(before);
  });

  it("the direct HTTP route cannot bypass it: a forged POST naming an out-of-scope Partner is 403 'Forbidden.' and writes nothing", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const campaign = await createCampaignInState(manager, { regionIds: ["Kerala"] });
    const outOfScopePartner = await createPartnerWithAccounts(admin, [], ["Karnataka"]);

    httpActor = manager;
    const response = await postAssignment(new Request("http://localhost/api/assignments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ campaignRef: campaign.campaignRef, partnerRef: outOfScopePartner.partnerRef, brief: { platforms: ["instagram"] } }) }));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({ error: "Forbidden." }); // the existing safe convention - no Partner detail leaks
    expect(JSON.stringify(body)).not.toContain(outOfScopePartner.partnerRef);
    expect(await writesFor(campaign.campaignRef, outOfScopePartner.partnerRef)).toEqual({ assignmentDocs: 0, claimDocExists: false, claimsForCampaign: 0, events: 0 });

    // The same route still creates for an in-scope Partner (201 + outcome header).
    const inScopePartner = await createPartnerWithAccounts(admin, [], ["Kerala"]);
    const ok = await postAssignment(new Request("http://localhost/api/assignments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ campaignRef: campaign.campaignRef, partnerRef: inScopePartner.partnerRef, brief: { platforms: ["instagram"] } }) }));
    expect(ok.status).toBe(201);
    expect(ok.headers.get("X-Assignment-Outcome")).toBe("created");
    httpActor = null;
  });

  it("a missing Partner is still the ordinary invalid_input, not a scope error", async () => {
    const manager = await actorFor("partnership_manager");
    const campaign = await createCampaignInState(manager);
    const result = await createAssignmentWithOutcome(manager, { campaignRef: campaign.campaignRef, partnerRef: "no-such-partner-ref" }, "req-missing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  it("an in-scope Partner still succeeds (region scope), and the created Assignment's own scope is unchanged (Campaign snapshot)", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const campaign = await createCampaignInState(manager, { regionIds: ["Kerala"] });
    const inScope = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: "inscope" }], ["Kerala"]);

    const result = await createAssignmentWithOutcome(manager, { campaignRef: campaign.campaignRef, partnerRef: inScope.partnerRef, partnerAccountRefs: inScope.accountRefs, brief: { platforms: ["instagram"] } }, "req-inscope");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe("created");
    expect(await writesFor(campaign.campaignRef, inScope.partnerRef)).toEqual({ assignmentDocs: 1, claimDocExists: true, claimsForCampaign: 1, events: 1 });
    const doc = (await assignmentDocsFor(campaign.campaignRef))[0]!.data();
    expect(doc.regionIds).toEqual(["Kerala"]); // Assignment scope = the Campaign's snapshot, never the Partner's
  });

  it("an explicit PARTNER-type grant is honored: Manager reaches Karnataka-only creator-house ONLY through its own PARTNER grant", async () => {
    const manager = await actorFor("partnership_manager");
    const grants = await getActorScopeGrants(manager);
    expect(grants.some((g) => g.type === "PARTNER" && g.partnerId === "creator-house")).toBe(true);
    expect(grants.some((g) => g.type === "REGION" && g.region === "Karnataka")).toBe(false);
    expect(hasGlobalScope(grants)).toBe(false);

    const campaign = await createCampaignInState(manager, { regionIds: ["Kerala"] });
    const result = await createAssignmentWithOutcome(manager, { campaignRef: campaign.campaignRef, partnerRef: "creator-house", brief: { platforms: ["instagram"] } }, "req-grant");
    expect(result.ok).toBe(true);
  });

  it("Super Admin passes only because of its explicit GLOBAL grant (asserted via the grant, not the role name)", async () => {
    const admin = await actorFor("super_admin");
    const grants = await getActorScopeGrants(admin);
    expect(hasGlobalScope(grants)).toBe(true);
    expect(grants.filter((g) => g.type === "GLOBAL")).toHaveLength(1);

    const campaign = await createCampaignInState(admin, { regionIds: ["Uttar Pradesh"] });
    const partner = await createPartnerWithAccounts(admin, [], ["Uttar Pradesh"]);
    const result = await createAssignmentWithOutcome(admin, { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, brief: { platforms: ["instagram"] } }, "req-global");
    expect(result.ok).toBe(true);
  });

  it("no role-rank fallback: Head (higher role, broader grants) is denied a Partner outside its OWN grants, yet allowed one inside them", async () => {
    const admin = await actorFor("super_admin");
    const head = await actorFor("partnership_head");
    const headGrants = await getActorScopeGrants(head);
    expect(hasGlobalScope(headGrants)).toBe(false);
    expect(headGrants.some((g) => g.type === "REGION" && g.region === "Uttar Pradesh")).toBe(false);
    expect(headGrants.some((g) => g.type === "REGION" && g.region === "Karnataka")).toBe(true);

    const campaign = await createCampaignInState(head, { regionIds: ["Kerala"] });
    const outside = await createPartnerWithAccounts(admin, [], ["Uttar Pradesh"]);
    const inside = await createPartnerWithAccounts(admin, [], ["Karnataka"]); // Head holds Karnataka; Manager does not

    const denied = await createAssignmentWithOutcome(head, { campaignRef: campaign.campaignRef, partnerRef: outside.partnerRef, brief: { platforms: ["instagram"] } }, "req-head-out");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("scope_denied");
    expect(await writesFor(campaign.campaignRef, outside.partnerRef)).toEqual({ assignmentDocs: 0, claimDocExists: false, claimsForCampaign: 0, events: 0 });

    const allowed = await createAssignmentWithOutcome(head, { campaignRef: campaign.campaignRef, partnerRef: inside.partnerRef, brief: { platforms: ["instagram"] } }, "req-head-in");
    expect(allowed.ok).toBe(true);
  });

  it("a denied create does not consume the (Campaign, Partner) slot: an actor WITH scope can still create afterwards", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const campaign = await createCampaignInState(manager, { regionIds: ["Kerala"] });
    const karnatakaPartner = await createPartnerWithAccounts(admin, [], ["Karnataka"]);
    const input = { campaignRef: campaign.campaignRef, partnerRef: karnatakaPartner.partnerRef, brief: { platforms: ["instagram"] } };

    expect((await createAssignmentWithOutcome(manager, input, "req-denied")).ok).toBe(false);
    const afterwards = await createAssignmentWithOutcome(head, input, "req-allowed");
    expect(afterwards.ok).toBe(true);
    if (afterwards.ok) expect(afterwards.data.outcome).toBe("created");
  });
});

// ---- editAssignmentBrief invariants ---------------------------------------

async function createDraft(options: { campaignPlatforms?: string[]; accounts?: Array<{ platform: string; handle: string; inactive?: boolean }> } = {}) {
  const admin = await actorFor("super_admin");
  const manager = await actorFor("partnership_manager");
  const campaign = await createCampaignInState(manager, { platforms: options.campaignPlatforms ?? ["instagram", "youtube"] });
  const partner = await createPartnerWithAccounts(admin, options.accounts ?? [{ platform: "instagram", handle: "own" }]);
  const created = await createAssignmentWithOutcome(manager, { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, partnerAccountRefs: partner.accountRefs.slice(0, 1), brief: { platforms: ["instagram"], instructions: "Original." } }, `req-${unique("draft")}`);
  if (!created.ok) throw new Error(`create failed: ${created.message}`);
  const snap = (await assignmentsCollection().where("assignmentRef", "==", created.data.assignment.assignmentRef).limit(1).get()).docs[0]!;
  return { admin, manager, campaign, partner, assignment: created.data.assignment, uid: snap.id };
}

async function rawAssignment(uid: string) {
  return (await assignmentsCollection().doc(uid).get()).data();
}
async function eventCount(uid: string) {
  return (await assignmentEventsCollection(uid).get()).size;
}

// Runs one edit expected to FAIL, and proves it changed nothing at all.
async function expectRejectedAndUnchanged(fixture: Awaited<ReturnType<typeof createDraft>>, payload: Record<string, unknown>, messagePattern: RegExp) {
  const beforeDoc = await rawAssignment(fixture.uid);
  const beforeEvents = await eventCount(fixture.uid);
  const result = await editAssignmentBrief(fixture.manager, fixture.assignment.assignmentRef, { ...payload, expectedVersion: fixture.assignment.version }, `req-${unique("bad-edit")}`);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("invalid_input");
  expect(result.message).toMatch(messagePattern);
  // Version, updatedAt, brief, partnerAccountRefs - the whole document - identical; no event.
  expect(await rawAssignment(fixture.uid)).toEqual(beforeDoc);
  expect(await eventCount(fixture.uid)).toBe(beforeEvents);
}

describe("editAssignmentBrief - create-time invariants hold after edit", () => {
  it("rejects an account that belongs to ANOTHER Partner (matched by ref, never by name)", async () => {
    const fixture = await createDraft();
    const other = await createPartnerWithAccounts(fixture.admin, [{ platform: "instagram", handle: "other" }]);
    await expectRejectedAndUnchanged(fixture, { partnerAccountRefs: other.accountRefs }, /does not belong to this Assignment's Partner/);
  });

  it("rejects an unknown / forged Partner Account ref", async () => {
    const fixture = await createDraft();
    await expectRejectedAndUnchanged(fixture, { partnerAccountRefs: ["forged-account-ref"] }, /does not resolve to a real Partner Account/);
  });

  it("rejects an INACTIVE account", async () => {
    const fixture = await createDraft({ accounts: [{ platform: "instagram", handle: "own" }, { platform: "instagram", handle: "off", inactive: true }] });
    await expectRejectedAndUnchanged(fixture, { partnerAccountRefs: [fixture.partner.accountRefs[1]!] }, /inactive/);
  });

  it("rejects an account whose platform is not one of the Campaign's platforms", async () => {
    const fixture = await createDraft({ campaignPlatforms: ["instagram"], accounts: [{ platform: "instagram", handle: "own" }, { platform: "tiktok", handle: "wrong" }] });
    await expectRejectedAndUnchanged(fixture, { partnerAccountRefs: [fixture.partner.accountRefs[1]!] }, /not part of this Campaign's own platforms/);
  });

  it("a rejected edit is atomic: a valid field in the same payload is NOT applied either", async () => {
    const fixture = await createDraft();
    const other = await createPartnerWithAccounts(fixture.admin, [{ platform: "instagram", handle: "atomic" }]);
    await expectRejectedAndUnchanged(fixture, { instructions: "Should never land.", partnerAccountRefs: other.accountRefs }, /does not belong/);
    const doc = (await rawAssignment(fixture.uid))!;
    expect((doc.brief as { instructions: string }).instructions).toBe("Original.");
  });

  it("a compatible account with an un-normalized platform (\"  YouTube \") is accepted via the shared normalizer, and multiple accounts on one platform are fine", async () => {
    const fixture = await createDraft({ accounts: [{ platform: "instagram", handle: "own" }, { platform: "  YouTube ", handle: "yt" }, { platform: "Instagram", handle: "second" }] });
    const result = await editAssignmentBrief(fixture.manager, fixture.assignment.assignmentRef, { partnerAccountRefs: fixture.partner.accountRefs, expectedVersion: fixture.assignment.version }, "req-edit-ok");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.partnerAccountRefs).toEqual(fixture.partner.accountRefs);
    expect(result.data.version).toBe(fixture.assignment.version + 1);
    expect(await eventCount(fixture.uid)).toBe(2); // created + edited
  });

  it("still rejects a brief platform outside the Campaign's platforms", async () => {
    const fixture = await createDraft({ campaignPlatforms: ["instagram"] });
    await expectRejectedAndUnchanged(fixture, { platforms: ["youtube"] }, /not part of this Campaign's own platforms/);
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["ftp:", "ftp://example.com/brief.pdf"],
    ["missing scheme", "example.com/brief.pdf"],
    ["whitespace", "https://example.com/a b"],
  ])("rejects an unsafe resource link URL (%s)", async (_label, url) => {
    const fixture = await createDraft();
    await expectRejectedAndUnchanged(fixture, { resourceLinks: [{ label: "Brief", url }] }, /valid http\(s\) URL/);
  });

  it("one unsafe link in a batch rejects the WHOLE edit", async () => {
    const fixture = await createDraft();
    await expectRejectedAndUnchanged(fixture, { resourceLinks: [{ label: "Good", url: "https://example.com/ok" }, { label: "Bad", url: "javascript:alert(1)" }] }, /valid http\(s\) URL/);
  });

  it("valid http/https resource links succeed and shareExternally stays fail-closed (false unless explicit)", async () => {
    const fixture = await createDraft();
    const result = await editAssignmentBrief(
      fixture.manager,
      fixture.assignment.assignmentRef,
      { resourceLinks: [{ label: "Plain", url: "http://example.com/a" }, { label: "Secure", url: "https://example.com/b" }, { label: "Shared", url: "https://example.com/c", shareExternally: true }], expectedVersion: fixture.assignment.version },
      "req-links-ok",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.brief.resourceLinks.map((l) => [l.label, l.shareExternally])).toEqual([["Plain", false], ["Secure", false], ["Shared", true]]);
  });

  it.each([
    ["campaignRef", { campaignRef: "some-other-campaign" }],
    ["partnerRef", { partnerRef: "some-other-partner" }],
    ["partnerAccountRef (singular)", { partnerAccountRef: "x" }],
    ["assignmentRef", { assignmentRef: "another-assignment" }],
    ["status", { status: "ASSIGNED" }],
  ])("Campaign/Partner identity is immutable: an edit payload naming %s is rejected (strict) and changes nothing", async (_label, extra) => {
    const fixture = await createDraft();
    await expectRejectedAndUnchanged(fixture, { instructions: "Sneaky.", ...extra }, /./);
    const doc = (await rawAssignment(fixture.uid))!;
    expect(doc.campaignRef).toBe(fixture.campaign.campaignRef);
    expect(doc.partnerRef).toBe(fixture.partner.partnerRef);
  });

  it("the DRAFT-only rule and the edit event are unchanged: a valid edit bumps version once and writes exactly one 'edited' event", async () => {
    const fixture = await createDraft();
    const result = await editAssignmentBrief(fixture.manager, fixture.assignment.assignmentRef, { instructions: "Updated.", expectedVersion: fixture.assignment.version }, "req-plain");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.brief.instructions).toBe("Updated.");
    const kinds = (await assignmentEventsCollection(fixture.uid).get()).docs.map((d) => d.data().kind).sort();
    expect(kinds).toEqual(["created", "edited"]);
  });
});
