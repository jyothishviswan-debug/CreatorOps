// Step 12C.1 - real reads/writes against the running Firestore/Auth
// emulator (no mocks): contextual Create Assignment from Campaign Detail
// (the outcome-aware create, the trusted create-options read) plus the real
// Campaign Detail downstream summary. Run with `pnpm test:emulator` against
// a running `pnpm firebase:emulators`.
//
// Every test builds its OWN fresh Campaign (and, where a (Campaign,
// Partner) pair matters, fresh Partners) - the (campaignRef, partnerRef)
// claim is permanent, and other emulator test files run in parallel, so
// nothing here counts global collections; side-effect proofs are always
// scoped to this test's own Campaign/Assignment.
import { beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";

import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { seedVendorsData } from "@/server/vendors/seed-vendors-data";
import { seedCampaignsData } from "@/server/campaigns/seed-campaigns-data";
import { seedAssignmentsData } from "@/server/assignments/seed-assignments-data";
import { seedContentData } from "@/server/content/seed-content-data";
import { seedAnalyticsData } from "@/server/analytics/seed-analytics-data";

import { createCampaign, getCampaign } from "@/server/campaigns/campaign-service";
import { transitionCampaignLifecycle } from "@/server/campaigns/campaign-lifecycle-service";
import { campaignsCollection } from "@/server/campaigns/firestore";
import { createPartner } from "@/server/partners/partner-service";
import { createPartnerAccount, setPartnerAccountStatus } from "@/server/partners/partner-account-service";
import { createAssignment, createAssignmentWithOutcome, getAssignment, listAssignments } from "@/server/assignments/assignment-service";
import { transitionAssignmentLifecycle } from "@/server/assignments/assignment-lifecycle-service";
import { assignmentActiveClaimsCollection, assignmentEventsCollection, assignmentsCollection, assignmentSubmissionSessionsCollection, assignmentExternalSubmissionsCollection } from "@/server/assignments/firestore";
import { createExternalSubmissionSession, submitExternalLinks } from "@/server/assignments/external-submission-service";
import { contentCollection } from "@/server/content/firestore";
import { listContent } from "@/server/content/content-service";
import { approveContentThread, requestContentRevision } from "@/server/content/content-lifecycle-service";
import { analyticsContentSourceRecordsCollection } from "@/server/analytics/firestore";
import { evaluateCampaignAnalyticsReadiness } from "@/server/analytics/campaign-readiness";
import { executeAnalyticsImport } from "@/server/analytics/import-service";

import { getAssignmentCreateOptions, MAX_ASSIGNMENT_PARTNER_SEARCH_RESULTS } from "./assignment-options-service";
import { getCampaignDownstreamSummary } from "./detail-downstream-service";

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

async function createCampaignInState(actor: ActorContext, options: { regionIds?: string[]; platforms?: string[]; state: "DRAFT" | "PLANNED" | "ACTIVE" }): Promise<{ campaignRef: string }> {
  const created = await createCampaign(
    actor,
    { name: unique("Detail Assignment Campaign"), objective: "Step 12C.1 emulator coverage.", platforms: options.platforms ?? ["instagram"], startDate: "2026-01-01", endDate: "2026-12-01", regionIds: options.regionIds ?? ["Kerala"], defaultReviewPolicy: "REVIEW_REQUIRED" },
    `req-${unique("create")}`,
  );
  if (!created.ok) throw new Error(`createCampaign failed: ${created.message}`);
  let version = created.data.version;
  if (options.state !== "DRAFT") {
    const planned = await transitionCampaignLifecycle(actor, created.data.campaignRef, { to: "PLANNED", expectedVersion: version }, `req-${unique("plan")}`);
    if (!planned.ok) throw new Error(`PLANNED failed: ${planned.message}`);
    version = planned.data.version;
  }
  if (options.state === "ACTIVE") {
    const active = await transitionCampaignLifecycle(actor, created.data.campaignRef, { to: "ACTIVE", expectedVersion: version }, `req-${unique("active")}`);
    if (!active.ok) throw new Error(`ACTIVE failed: ${active.message}`);
  }
  return { campaignRef: created.data.campaignRef };
}

// A fresh ACTIVE Partner (Kerala-scoped so Manager/Head/Admin all reach it)
// with the given accounts. Returns the opaque refs.
async function createPartnerWithAccounts(
  admin: ActorContext,
  accounts: Array<{ platform: string; handle: string; displayName?: string; inactive?: boolean }>,
  displayName = unique("Detail Partner"),
): Promise<{ partnerRef: string; displayName: string; accountRefs: string[] }> {
  const partner = await createPartner(admin, { displayName, regionIds: ["Kerala"] }, `req-${unique("partner")}`);
  if (!partner.ok) throw new Error(`createPartner failed: ${partner.message}`);
  const accountRefs: string[] = [];
  for (const account of accounts) {
    const created = await createPartnerAccount(admin, partner.data.partnerRef, { platform: account.platform, handle: `${account.handle}-${runId}-${++counter}`, ...(account.displayName ? { displayName: account.displayName } : {}) }, `req-${unique("account")}`);
    if (!created.ok) throw new Error(`createPartnerAccount failed: ${created.message}`);
    accountRefs.push(created.data.partnerAccountRef);
    if (account.inactive) {
      const off = await setPartnerAccountStatus(admin, created.data.partnerAccountRef, { status: "INACTIVE", expectedVersion: created.data.version }, `req-${unique("inactive")}`);
      if (!off.ok) throw new Error(`setPartnerAccountStatus failed: ${off.message}`);
    }
  }
  return { partnerRef: partner.data.partnerRef, displayName: partner.data.displayName, accountRefs };
}

async function issueAndStart(actor: ActorContext, assignmentRef: string, version: number): Promise<number> {
  let v = version;
  for (const to of ["ASSIGNED", "ACCEPTED", "IN_PROGRESS"] as const) {
    const step = await transitionAssignmentLifecycle(actor, assignmentRef, { to, expectedVersion: v }, `req-${unique(to)}`);
    if (!step.ok) throw new Error(`transition(${to}) failed: ${step.message}`);
    v = step.data.version;
  }
  return v;
}

async function submitRealLink(actor: ActorContext, assignmentRef: string, url: string): Promise<void> {
  const session = await createExternalSubmissionSession(actor, assignmentRef, { recipientType: "PARTNER" }, `req-${unique("session")}`);
  if (!session.ok) throw new Error(`createExternalSubmissionSession failed: ${session.message}`);
  const submitted = await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url }]);
  if (!submitted.ok) throw new Error(`submitExternalLinks failed: ${submitted.message}`);
}

async function threadFor(actor: ActorContext, assignmentRef: string) {
  const result = await listContent(actor, { assignmentRef, limit: 1 });
  if (!result.ok || !result.data.content[0]) throw new Error(`no Content thread for ${assignmentRef}`);
  return result.data.content[0];
}

function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, into));
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      collectKeys(inner, into);
    }
  }
  return into;
}

async function rawCampaignDoc(campaignRef: string) {
  const snap = await campaignsCollection().where("campaignRef", "==", campaignRef).limit(1).get();
  return snap.docs[0]!.data();
}

describe("Create Assignment from Campaign - trusted outcome-aware create", () => {
  it("Manager creates a DRAFT Assignment from an in-scope ACTIVE Campaign and it is visible in the scoped list", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const campaign = await createCampaignInState(manager, { state: "ACTIVE" });
    const partner = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: "one" }]);

    const result = await createAssignmentWithOutcome(
      manager,
      {
        campaignRef: campaign.campaignRef,
        partnerRef: partner.partnerRef,
        partnerAccountRefs: partner.accountRefs,
        brief: { platforms: ["instagram"], instructions: "Post one reel.", requiredCount: 1, formats: ["Reel"], hashtags: ["Launch"], dueAt: "2026-11-01", resourceLinks: [{ label: "Brief", url: "https://example.com/brief.pdf" }] },
      },
      "req-create",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe("created");
    expect(result.data.assignment.status).toBe("DRAFT");
    expect(result.data.assignment.brief.resourceLinks[0]?.shareExternally).toBe(false); // fail-closed default

    const listed = await listAssignments(manager, { campaignRef: campaign.campaignRef, limit: 20 });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.data.assignments.map((a) => a.assignmentRef)).toContain(result.data.assignment.assignmentRef);
    const fetched = await getAssignment(manager, result.data.assignment.assignmentRef);
    expect(fetched.ok).toBe(true);
  });

  it("creation has NO side effects: no Content, no session/token/external submission, no Analytics, Campaign document untouched, no Finance collection", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const campaign = await createCampaignInState(manager, { state: "ACTIVE" });
    const partner = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: "sidefx" }]);
    const before = await rawCampaignDoc(campaign.campaignRef);
    const beforeDto = await getCampaign(manager, campaign.campaignRef);

    const result = await createAssignmentWithOutcome(manager, { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, partnerAccountRefs: partner.accountRefs, brief: { platforms: ["instagram"] } }, "req-sidefx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const assignmentUid = (await assignmentsCollection().where("assignmentRef", "==", result.data.assignment.assignmentRef).limit(1).get()).docs[0]!.id;

    // Content: none for this Campaign/Assignment.
    expect((await contentCollection().where("campaignRef", "==", campaign.campaignRef).get()).size).toBe(0);
    // Public submission: no session/token doc, no external submission doc.
    expect((await assignmentSubmissionSessionsCollection().where("assignmentRef", "==", result.data.assignment.assignmentRef).get()).size).toBe(0);
    expect((await assignmentExternalSubmissionsCollection().where("assignmentRef", "==", result.data.assignment.assignmentRef).get()).size).toBe(0);
    // Assignment history: exactly one "created" event, nothing like an issue/link event.
    const events = await assignmentEventsCollection(assignmentUid).get();
    expect(events.docs.map((d) => d.data().kind)).toEqual(["created"]);
    // Analytics: nothing matched to this Campaign, readiness untouched.
    expect((await analyticsContentSourceRecordsCollection().where("matchedCampaignRef", "==", campaign.campaignRef).get()).size).toBe(0);
    expect(await evaluateCampaignAnalyticsReadiness(campaign.campaignRef)).toEqual({ hasLinkedSourceRecords: false, matchedCount: 0, unmatchedCount: 0, lastDataAt: null });
    // Campaign: byte-identical (version/updatedAt/status/everything).
    expect(await rawCampaignDoc(campaign.campaignRef)).toEqual(before);
    const afterDto = await getCampaign(manager, campaign.campaignRef);
    expect(afterDto.ok && beforeDto.ok && afterDto.data).toEqual(beforeDto.ok && beforeDto.data);
    if (afterDto.ok) expect(afterDto.data.status).toBe("ACTIVE");
    // Finance: Assignment creation never introduces a Payable / Invoice / Payment (or any other Finance-shaped) collection. The Step 14A
    // Agreement foundation legitimately owns four roots (other files create them concurrently), so those are exempt here - a Campaign or
    // Assignment writing Agreement data is separately barred by the Agreement module's static guards.
    const rootCollections = (await getAdminFirestore().listCollections()).map((c) => c.id);
    expect(rootCollections.filter((name) => /finance|agreement|payable|invoice|payment|payee/i.test(name) && !/^finance(Agreements|AgreementClaims|ContractArtifacts|AgreementRestrictedExtractions)$/.test(name))).toEqual([]);
  });

  it("a Campaign outside the actor's scope is denied (scope_denied), and no Assignment is written", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    // Manager holds no Uttar Pradesh grant.
    const outside = await createCampaignInState(admin, { regionIds: ["Uttar Pradesh"], state: "ACTIVE" });
    const partner = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: "scope" }]);

    const result = await createAssignmentWithOutcome(manager, { campaignRef: outside.campaignRef, partnerRef: partner.partnerRef, brief: { platforms: ["instagram"] } }, "req-scope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unauthorized");
    expect(result.reason).toBe("scope_denied");
    expect((await assignmentsCollection().where("campaignRef", "==", outside.campaignRef).get()).size).toBe(0);

    // The options read is denied the same way.
    const options = await getAssignmentCreateOptions(manager, outside.campaignRef, {});
    expect(options.ok).toBe(false);
    if (!options.ok) expect(options.reason).toBe("scope_denied");
  });

  it("a repeat create for the same (Campaign, Partner) returns outcome 'existing' with the SAME Assignment and exactly one doc + one claim", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const campaign = await createCampaignInState(manager, { state: "PLANNED" });
    const partner = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: "dup" }]);
    const input = { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, partnerAccountRefs: partner.accountRefs, brief: { platforms: ["instagram"] } };

    const first = await createAssignmentWithOutcome(manager, input, "req-1");
    const second = await createAssignmentWithOutcome(manager, input, "req-2");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.outcome).toBe("created");
    expect(second.data.outcome).toBe("existing");
    expect(second.data.assignment.assignmentRef).toBe(first.data.assignment.assignmentRef);

    expect((await assignmentsCollection().where("campaignRef", "==", campaign.campaignRef).get()).size).toBe(1);
    expect((await assignmentActiveClaimsCollection().where("campaignRef", "==", campaign.campaignRef).get()).size).toBe(1);

    // The legacy wrapper is unchanged: plain idempotent success, same Assignment.
    const legacy = await createAssignment(manager, input, "req-3");
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.data.assignmentRef).toBe(first.data.assignment.assignmentRef);
  });

  it("concurrent creates: exactly one 'created', the rest 'existing', one doc, one claim, one 'created' event", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    for (let round = 0; round < 2; round += 1) {
      const campaign = await createCampaignInState(manager, { state: "ACTIVE" });
      const partner = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: `race${round}` }]);
      const input = { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, partnerAccountRefs: partner.accountRefs, brief: { platforms: ["instagram"] } };

      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => createAssignmentWithOutcome(manager, input, `req-race-${round}-${i}`)));
      expect(results.every((r) => r.ok)).toBe(true);
      const outcomes = results.map((r) => (r.ok ? r.data.outcome : "error"));
      expect(outcomes.filter((o) => o === "created")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "existing")).toHaveLength(3);
      expect(new Set(results.map((r) => (r.ok ? r.data.assignment.assignmentRef : null))).size).toBe(1);

      const docs = await assignmentsCollection().where("campaignRef", "==", campaign.campaignRef).get();
      expect(docs.size).toBe(1);
      expect((await assignmentActiveClaimsCollection().where("campaignRef", "==", campaign.campaignRef).get()).size).toBe(1);
      expect((await assignmentEventsCollection(docs.docs[0]!.id).get()).size).toBe(1);
    }
  }, 30_000);

  it("Campaign lifecycle is enforced: DRAFT, PAUSED-equivalent and terminal Campaigns reject creation", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const draft = await createCampaignInState(manager, { state: "DRAFT" });
    const partner = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: "life" }]);
    const result = await createAssignmentWithOutcome(manager, { campaignRef: draft.campaignRef, partnerRef: partner.partnerRef, brief: { platforms: ["instagram"] } }, "req-draft");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/DRAFT/);

    const options = await getAssignmentCreateOptions(manager, draft.campaignRef, {});
    expect(options.ok).toBe(false);
    if (!options.ok) expect(options.code).toBe("invalid_input");
  });

  it("Partner Account rules: a compatible account is accepted; a second account on the same platform is accepted", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const campaign = await createCampaignInState(manager, { platforms: ["instagram", "youtube"], state: "ACTIVE" });
    const partner = await createPartnerWithAccounts(admin, [
      { platform: "Instagram", handle: "main", displayName: "Main" },
      { platform: "instagram", handle: "reels", displayName: "Reels" },
      { platform: "YouTube", handle: "chan" },
    ]);

    const result = await createAssignmentWithOutcome(manager, { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, partnerAccountRefs: partner.accountRefs, brief: { platforms: ["instagram", "youtube"] } }, "req-accounts");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.assignment.partnerAccountRefs).toEqual(partner.accountRefs);
  });

  it("Partner Account rules: an incompatible-platform account is rejected server-side", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const campaign = await createCampaignInState(manager, { platforms: ["instagram"], state: "ACTIVE" });
    const partner = await createPartnerWithAccounts(admin, [{ platform: "tiktok", handle: "wrong" }]);

    const result = await createAssignmentWithOutcome(manager, { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, partnerAccountRefs: partner.accountRefs, brief: { platforms: ["instagram"] } }, "req-wrong");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
    expect(result.message).toMatch(/platform/i);
    expect((await assignmentsCollection().where("campaignRef", "==", campaign.campaignRef).get()).size).toBe(0);
  });

  it("Partner Account rules: an INACTIVE account is rejected server-side", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const campaign = await createCampaignInState(manager, { state: "ACTIVE" });
    const partner = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: "off", inactive: true }]);

    const result = await createAssignmentWithOutcome(manager, { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, partnerAccountRefs: partner.accountRefs, brief: { platforms: ["instagram"] } }, "req-off");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/inactive/i);
  });

  it("resource link URLs must be http(s) on the trusted server", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const campaign = await createCampaignInState(manager, { state: "ACTIVE" });
    const partner = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: "links" }]);
    for (const url of ["javascript:alert(1)", "ftp://example.com/x", "not a url", "example.com"]) {
      const result = await createAssignmentWithOutcome(manager, { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, brief: { resourceLinks: [{ label: "Bad", url }] } }, "req-url");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/http/i);
    }
    expect((await assignmentsCollection().where("campaignRef", "==", campaign.campaignRef).get()).size).toBe(0);
  });

  it("Viewer and Analyst are denied create (feature_denied) and get no create options", async () => {
    const manager = await actorFor("partnership_manager");
    const campaign = await createCampaignInState(manager, { state: "ACTIVE" });
    for (const role of ["viewer", "analyst"]) {
      const actor = await actorFor(role);
      const create = await createAssignmentWithOutcome(actor, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct" }, "req");
      expect(create.ok).toBe(false);
      const options = await getAssignmentCreateOptions(actor, campaign.campaignRef, {});
      expect(options.ok).toBe(false);
    }
  });
});

describe("Assignment create options (trusted Partner / Partner Account picker)", () => {
  it("Partner search is bounded to 10, ACTIVE-only, and returns only safe fields", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const campaign = await createCampaignInState(manager, { state: "ACTIVE" });
    // 12 ACTIVE Partners sharing a unique prefix, plus one INACTIVE-looking name-mate is not needed:
    // the seeded INACTIVE/BLACKLISTED/ARCHIVED Partners must simply never appear.
    const prefix = `Bounded ${runId}`;
    for (let i = 0; i < 12; i += 1) await createPartner(admin, { displayName: `${prefix} ${String(i).padStart(2, "0")}`, regionIds: ["Kerala"], email: `secret${i}@example.com`, phone: "+91 90000 00000" }, `req-bulk-${i}`);

    const searched = await getAssignmentCreateOptions(manager, campaign.campaignRef, { q: prefix });
    expect(searched.ok).toBe(true);
    if (!searched.ok) return;
    expect(searched.data.partners).toHaveLength(MAX_ASSIGNMENT_PARTNER_SEARCH_RESULTS);
    expect(searched.data.hasMorePartners).toBe(true);
    expect(searched.data.selectedPartner).toBeNull();
    for (const partner of searched.data.partners) {
      expect(Object.keys(partner).sort()).toEqual(["displayName", "partnerRef", "regionLabels"]);
      expect(partner.displayName.startsWith(prefix)).toBe(true);
    }
    const serialized = JSON.stringify(searched.data);
    for (const forbidden of ["secret", "@example.com", "90000", "email", "phone", "legalName", "ownerUid", "originLead"]) expect(serialized).not.toContain(forbidden);

    // Empty query: still bounded to 10, still ACTIVE only.
    const defaults = await getAssignmentCreateOptions(manager, campaign.campaignRef, {});
    expect(defaults.ok).toBe(true);
    if (!defaults.ok) return;
    expect(defaults.data.partners.length).toBeLessThanOrEqual(MAX_ASSIGNMENT_PARTNER_SEARCH_RESULTS);
    const inactiveSeed = await getAssignmentCreateOptions(manager, campaign.campaignRef, { q: "" });
    expect(inactiveSeed.ok).toBe(true);
    // The seeded non-ACTIVE Partners are never offered, even when searched by name.
    for (const q of ["inactive", "blacklisted", "archived"]) {
      const r = await getAssignmentCreateOptions(manager, campaign.campaignRef, { q });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.partners.map((p) => p.partnerRef)).not.toEqual(expect.arrayContaining(["seed-partner-inactive", "seed-partner-blacklisted", "seed-partner-archived"]));
    }
  });

  it("returns the selected Partner's own accounts with a narrow DTO, selectable flags and reasons - no identity internals", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const campaign = await createCampaignInState(manager, { platforms: ["instagram"], state: "ACTIVE" });
    const partner = await createPartnerWithAccounts(admin, [
      { platform: "Instagram", handle: "ok-one", displayName: "One" },
      { platform: "instagram", handle: "ok-two", displayName: "Two" },
      { platform: "tiktok", handle: "other", displayName: "Other" },
      { platform: "instagram", handle: "gone", displayName: "Gone", inactive: true },
    ]);
    const other = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: "not-mine" }]);

    const options = await getAssignmentCreateOptions(manager, campaign.campaignRef, { partnerRef: partner.partnerRef });
    expect(options.ok).toBe(true);
    if (!options.ok) return;
    const selected = options.data.selectedPartner!;
    expect(selected.partnerRef).toBe(partner.partnerRef);
    expect(selected.existingAssignment).toBeNull();
    // Only THIS Partner's accounts.
    expect(selected.accounts.map((a) => a.partnerAccountRef).sort()).toEqual([...partner.accountRefs].sort());
    expect(selected.accounts.map((a) => a.partnerAccountRef)).not.toContain(other.accountRefs[0]);

    const byLabel = Object.fromEntries(selected.accounts.map((a) => [a.label, a]));
    expect(byLabel["One"]).toMatchObject({ platform: "instagram", platformLabel: "Instagram", selectable: true, unavailableReason: null });
    expect(byLabel["Two"]).toMatchObject({ selectable: true }); // multiple same-platform accounts stay selectable
    expect(byLabel["Other"]).toMatchObject({ selectable: false, unavailableReason: "Platform not part of this Campaign" });
    expect(byLabel["Gone"]).toMatchObject({ selectable: false, unavailableReason: "Inactive account" });

    const keys = collectKeys(options.data);
    for (const forbidden of ["normalizedIdentity", "platformAccountId", "followerSnapshot", "profileUrl", "uid", "ownerUid", "email", "phone", "legalName"]) expect(keys.has(forbidden)).toBe(false);
    // Campaign context is safe display fields only.
    expect(Object.keys(options.data.campaign).sort()).toEqual(["endDate", "name", "objective", "platforms", "regionIds", "startDate"]);
  });

  it("reports an existing (Campaign, Partner) Assignment - openable when in scope, ref hidden when out of scope", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const campaign = await createCampaignInState(manager, { state: "ACTIVE" });
    const partner = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: "exists" }]);
    const created = await createAssignmentWithOutcome(manager, { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, partnerAccountRefs: partner.accountRefs, brief: { platforms: ["instagram"] } }, "req");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const options = await getAssignmentCreateOptions(manager, campaign.campaignRef, { partnerRef: partner.partnerRef });
    expect(options.ok).toBe(true);
    if (options.ok) expect(options.data.selectedPartner!.existingAssignment).toEqual({ assignmentRef: created.data.assignment.assignmentRef, status: "DRAFT", canOpen: true });

    // Out of Assignment scope: build a Campaign only reachable through a
    // non-bridging path. civic-voices' seeded Assignments are Tamil Nadu -
    // Head reaches the Campaign via an explicit CAMPAIGN grant but that
    // deliberately does not bridge into Assignment scope.
    const civic = await getAssignmentCreateOptions(head, "civic-voices", { partnerRef: "seed-partner-direct" });
    expect(civic.ok).toBe(true);
    if (civic.ok) {
      expect(civic.data.selectedPartner!.existingAssignment).toEqual({ assignmentRef: null, status: null, canOpen: false });
    }
    // And the create itself never returns that out-of-scope Assignment's identity.
    const repeat = await createAssignmentWithOutcome(head, { campaignRef: "civic-voices", partnerRef: "seed-partner-direct" }, "req-oos");
    expect(repeat.ok).toBe(false);
    if (!repeat.ok) expect(repeat.code).toBe("conflict");
  });

  it("an unknown or out-of-scope Partner is a safe denial, never data", async () => {
    const manager = await actorFor("partnership_manager");
    const admin = await actorFor("super_admin");
    const campaign = await createCampaignInState(manager, { state: "ACTIVE" });
    const missing = await getAssignmentCreateOptions(manager, campaign.campaignRef, { partnerRef: "does-not-exist" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("not_found");

    // A Partner outside Manager's scope (Uttar Pradesh only).
    const outside = await createPartner(admin, { displayName: unique("Outside Partner"), regionIds: ["Uttar Pradesh"] }, "req-outside");
    if (!outside.ok) throw new Error("unreachable");
    const denied = await getAssignmentCreateOptions(manager, campaign.campaignRef, { partnerRef: outside.data.partnerRef });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("unauthorized");
  });
});

describe("Campaign Detail downstream summary", () => {
  it("counts real Assignment + Content truth: DRAFT included in the total, CANCELLED excluded, thread statuses from canonical threads", async () => {
    const admin = await actorFor("super_admin");
    const campaign = await createCampaignInState(admin, { state: "ACTIVE" });

    // 6 distinct Partners, one per Assignment.
    // Accounts are irrelevant to the counts - skip creating them (keeps this test light).
    const partners = await Promise.all(Array.from({ length: 6 }, () => createPartnerWithAccounts(admin, [])));
    const create = async (index: number) => {
      const result = await createAssignment(admin, { campaignRef: campaign.campaignRef, partnerRef: partners[index]!.partnerRef, brief: { platforms: ["instagram"] } }, `req-down-${index}`);
      if (!result.ok) throw new Error(`createAssignment failed: ${result.message}`);
      return result.data;
    };

    const empty = await getCampaignDownstreamSummary(admin, campaign.campaignRef);
    expect(empty.ok && empty.data.assignments).toEqual({ available: true, total: 0, draftCount: 0, issuedCount: 0, distinctPartnerCount: 0, truncated: false });

    // 0: DRAFT.
    await create(0);
    // 1: ASSIGNED (issued, no thread).
    const a1 = await create(1);
    const assigned = await transitionAssignmentLifecycle(admin, a1.assignmentRef, { to: "ASSIGNED", expectedVersion: a1.version }, "req");
    expect(assigned.ok).toBe(true);
    // 2: CANCELLED (must not count).
    const a2 = await create(2);
    const cancelled = await transitionAssignmentLifecycle(admin, a2.assignmentRef, { to: "CANCELLED", reason: "Test cancellation.", expectedVersion: a2.version }, "req");
    expect(cancelled.ok).toBe(true);
    // 3: UNDER_REVIEW, 4: APPROVED, 5: REVISION_REQUESTED.
    const threadStates: Array<{ index: number; finish: "review" | "approve" | "revise" }> = [
      { index: 3, finish: "review" },
      { index: 4, finish: "approve" },
      { index: 5, finish: "revise" },
    ];
    for (const { index, finish } of threadStates) {
      const a = await create(index);
      await issueAndStart(admin, a.assignmentRef, a.version);
      await submitRealLink(admin, a.assignmentRef, `https://instagram.com/p/down-${runId}-${index}`);
      const thread = await threadFor(admin, a.assignmentRef);
      if (finish === "approve") {
        const r = await approveContentThread(admin, thread.contentRef, { reviewedRevisionNumber: thread.reviewedRevisionNumber, expectedVersion: thread.version }, `req-${unique("approve")}`);
        expect(r.ok).toBe(true);
      } else if (finish === "revise") {
        const r = await requestContentRevision(admin, thread.contentRef, { reason: "Needs a clearer caption.", reviewedRevisionNumber: thread.reviewedRevisionNumber, expectedVersion: thread.version }, `req-${unique("revise")}`);
        expect(r.ok).toBe(true);
      }
    }

    const summary = await getCampaignDownstreamSummary(admin, campaign.campaignRef);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.data.assignments).toEqual({ available: true, total: 5, draftCount: 1, issuedCount: 4, distinctPartnerCount: 5, truncated: false });
    expect(summary.data.content).toEqual({ available: true, approvedCount: 1, underReviewCount: 1, revisionRequestedCount: 1, truncated: false });
    expect(summary.data.analytics).toMatchObject({ available: true, hasLinkedSourceRecords: false, matchedCount: 0 });
    expect(summary.data.canCreateAssignment).toBe(true);
  }, 30_000);

  it("Analytics readiness is the real helper's output once data is matched", async () => {
    const admin = await actorFor("super_admin");
    const analyst = await actorFor("analyst");
    const campaign = await createCampaignInState(admin, { state: "ACTIVE" });
    const partner = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: "an" }]);
    const created = await createAssignment(admin, { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, brief: { platforms: ["instagram"] } }, "req");
    if (!created.ok) throw new Error("unreachable");
    await issueAndStart(admin, created.data.assignmentRef, created.data.version);
    const url = `https://instagram.com/p/an-${runId}`;
    await submitRealLink(admin, created.data.assignmentRef, url);
    // Analytics only matches an APPROVED thread's published link.
    const thread = await threadFor(admin, created.data.assignmentRef);
    const approved = await approveContentThread(admin, thread.contentRef, { reviewedRevisionNumber: thread.reviewedRevisionNumber, expectedVersion: thread.version }, `req-${unique("approve")}`);
    expect(approved.ok).toBe(true);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Post URL", "Comments", "Likes"], [url, "3", "9"]]), "Content");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const imported = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename: `${unique("dl")}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, `req-${unique("import")}`);
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.data.counts.matched).toBe(1);

    const summary = await getCampaignDownstreamSummary(admin, campaign.campaignRef);
    expect(summary.ok).toBe(true);
    expect(summary.ok && summary.data.analytics.available).toBe(true);
    if (summary.ok && summary.data.analytics.available) {
      expect(summary.data.analytics.hasLinkedSourceRecords).toBe(true);
      expect(summary.data.analytics.matchedCount).toBe(1);
      expect(summary.data.analytics.lastDataAt).not.toBeNull();
    }
  });

  it("canCreateAssignment: true for Manager on PLANNED/ACTIVE; false on DRAFT; false for Viewer/Analyst with the Assignments/Content sections unavailable (not zeros)", async () => {
    const manager = await actorFor("partnership_manager");
    const planned = await createCampaignInState(manager, { state: "PLANNED" });
    const active = await createCampaignInState(manager, { state: "ACTIVE" });
    const draft = await createCampaignInState(manager, { state: "DRAFT" });

    for (const [ref, expected] of [
      [planned.campaignRef, true],
      [active.campaignRef, true],
      [draft.campaignRef, false],
    ] as const) {
      const summary = await getCampaignDownstreamSummary(manager, ref);
      expect(summary.ok).toBe(true);
      if (summary.ok) expect(summary.data.canCreateAssignment).toBe(expected);
    }

    // Viewer/Analyst can see Campaign Detail (Campaigns feature + scope) but hold no Assignments/Content access.
    const viewer = await actorFor("viewer");
    const viewerSummary = await getCampaignDownstreamSummary(viewer, active.campaignRef);
    expect(viewerSummary.ok).toBe(true);
    if (viewerSummary.ok) {
      expect(viewerSummary.data.canCreateAssignment).toBe(false);
      expect(viewerSummary.data.assignments).toEqual({ available: false });
      expect(viewerSummary.data.content).toEqual({ available: false });
      expect(JSON.stringify(viewerSummary.data)).not.toContain("total");
    }
    const analyst = await actorFor("analyst");
    const analystSummary = await getCampaignDownstreamSummary(analyst, active.campaignRef);
    // Analyst holds Kerala scope too; whatever Campaign access it has, it can never create.
    if (analystSummary.ok) {
      expect(analystSummary.data.canCreateAssignment).toBe(false);
      expect(analystSummary.data.assignments).toEqual({ available: false });
    }
  });

  it("a cross-scope actor gets a denial, never a summary", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const outside = await createCampaignInState(admin, { regionIds: ["Uttar Pradesh"], state: "ACTIVE" });
    const summary = await getCampaignDownstreamSummary(manager, outside.campaignRef);
    expect(summary.ok).toBe(false);
    if (!summary.ok) expect(summary.reason).toBe("scope_denied");
    const unauth = await getCampaignDownstreamSummary(null, outside.campaignRef);
    expect(unauth.ok).toBe(false);
  });

  it("the DTO contains only counts/booleans/timestamps - no raw refs or internals", async () => {
    const admin = await actorFor("super_admin");
    const campaign = await createCampaignInState(admin, { state: "ACTIVE" });
    const partner = await createPartnerWithAccounts(admin, [{ platform: "instagram", handle: "dto" }]);
    const created = await createAssignment(admin, { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, brief: { platforms: ["instagram"] } }, "req");
    if (!created.ok) throw new Error("unreachable");
    const summary = await getCampaignDownstreamSummary(admin, campaign.campaignRef);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const serialized = JSON.stringify(summary.data);
    for (const forbidden of [created.data.assignmentRef, partner.partnerRef, campaign.campaignRef, "uid", "Ref", "agreement", "payable", "invoice", "payment", "finance"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
