// Step 12C.2 - the Overview 100-vs-200 pagination fix, against the real
// Firestore emulator (no mocks). listAssignmentDocs/listContentDocs clamp a
// page to 100 rows, so the per-Campaign bound is reached by following the
// deterministic cursors (see ./bounded-pages.ts). These tests run the REAL
// services (getCampaignExecutionSummary / getCampaignExecutionOverview /
// getCampaignDownstreamSummary) over Campaigns whose Assignment rows are
// bulk-written with batched admin-SDK writes of schema-valid AssignmentDocs
// (a few hundred small writes per test, never hundreds of service calls) and
// a handful of real-shaped Content threads.
//
// ISOLATION (other emulator files run in parallel against the same
// emulator and several of them read the PORTFOLIO-wide Overview, e.g.
// execution-integration.emulator.test.ts compares a Manager's Overview totals
// with Super Admin's): the bulk fixtures must be invisible to every seeded
// non-global actor and must never inflate anyone else's portfolio.
//   - Every fixture Campaign lives in PRIVATE_REGION, a region no seeded
//     Manager/Head/Analyst/Viewer holds (seed-access-data grants only the
//     South and West Zones) and no other test uses - only the explicit
//     GLOBAL Super Admin grant reaches it. The ONE exception is the
//     scope-before-inclusion test, which needs a Campaign a Manager may
//     read: that Campaign is PLANNED (never in any ACTIVE portfolio scan),
//     so no Overview read anywhere sees it.
//   - Campaigns are PLANNED unless a test specifically exercises the
//     portfolio-wide Overview aggregate (the only ACTIVE fixtures).
//   - Bulk Assignments are dated far in the past, so any createdAt-desc list
//     another test reads puts its own (new) rows first.
//   - Every bulk doc is deleted again in afterEach (and afterAll), pass or
//     fail.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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

import { createCampaign } from "@/server/campaigns/campaign-service";
import { transitionCampaignLifecycle } from "@/server/campaigns/campaign-lifecycle-service";
import { getCampaignDocByRef } from "@/server/campaigns/firestore";
import { assignmentsCollection } from "@/server/assignments/firestore";
import { generateAssignmentRef } from "@/server/assignments/ids";
import { assignmentBriefSchema, assignmentDocSchema, type AssignmentStatus } from "@/server/assignments/types";
import { contentCollection } from "@/server/content/firestore";
import { generateContentRef } from "@/server/content/ids";
import { contentDocSchema, type ContentStatus } from "@/server/content/types";

import { getCampaignDownstreamSummary } from "./detail-downstream-service";
import { getCampaignExecutionOverview, getCampaignExecutionSummary, MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY } from "./execution-integration-service";

// Every bulk fixture doc written by a test is deleted again afterwards. The
// Overview reads EVERY active Campaign, so leaving hundreds of bulk
// Assignments behind would make other emulator files (which run in parallel
// against the same emulator) pay for these fixtures on every Overview call.
const bulkDocRefs: FirebaseFirestore.DocumentReference[] = [];
async function deleteBulkFixtures() {
  const db = getAdminFirestore();
  while (bulkDocRefs.length > 0) {
    const batch = db.batch();
    for (const ref of bulkDocRefs.splice(0, 400)) batch.delete(ref);
    await batch.commit();
  }
}
afterEach(deleteBulkFixtures);
afterAll(deleteBulkFixtures);

// A region no seeded non-global actor holds and no other test uses (see the
// ISOLATION note in the file header).
const PRIVATE_REGION = "Nagaland";

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

async function createCampaignInState(actor: ActorContext, regionIds: string[], state: "PLANNED" | "ACTIVE"): Promise<{ campaignRef: string }> {
  const created = await createCampaign(actor, { name: unique("Pagination Campaign"), objective: "Step 12C.2 pagination coverage.", platforms: ["instagram"], startDate: "2026-01-01", endDate: "2026-12-01", regionIds, defaultReviewPolicy: "REVIEW_REQUIRED" }, `req-${unique("create")}`);
  if (!created.ok) throw new Error(`createCampaign failed: ${created.message}`);
  const planned = await transitionCampaignLifecycle(actor, created.data.campaignRef, { to: "PLANNED", expectedVersion: created.data.version }, `req-${unique("plan")}`);
  if (!planned.ok) throw new Error(`PLANNED failed: ${planned.message}`);
  if (state === "ACTIVE") {
    const active = await transitionCampaignLifecycle(actor, created.data.campaignRef, { to: "ACTIVE", expectedVersion: planned.data.version }, `req-${unique("active")}`);
    if (!active.ok) throw new Error(`ACTIVE failed: ${active.message}`);
  }
  return { campaignRef: created.data.campaignRef };
}

const ISSUED_CYCLE: AssignmentStatus[] = ["ASSIGNED", "ACCEPTED", "IN_PROGRESS", "COMPLETED"];

type BulkPlan = {
  // Relevant (obligation) Assignments, statuses cycling ASSIGNED/ACCEPTED/IN_PROGRESS/COMPLETED.
  issued: number;
  draft?: number;
  cancelled?: number;
  // Scope snapshot written onto the bulk Assignments (defaults to the Campaign's own).
  regionIds?: string[];
  // Content threads (status) attached to the NEWEST issued Assignments, in order.
  threads?: ContentStatus[];
  // Rows already written for this Campaign by earlier calls: new rows are dated
  // AFTER them (so they are strictly the newest) and get fresh partnerRefs.
  offset?: number;
};

// Batched admin-SDK writes of schema-valid docs. createdAt is strictly
// increasing per doc so the list order (createdAt desc) is fully
// deterministic; issued/draft/cancelled rows are interleaved so irrelevant
// rows are spread across every page rather than conveniently at the end.
async function bulkWriteAssignments(campaignRef: string, plan: BulkPlan): Promise<{ issuedRefs: string[]; partnerRefs: Set<string>; rowsWritten: number }> {
  const campaign = await getCampaignDocByRef(campaignRef);
  if (!campaign) throw new Error("campaign missing");
  const statuses: AssignmentStatus[] = [];
  const issuedTotal = plan.issued;
  let draftLeft = plan.draft ?? 0;
  let cancelledLeft = plan.cancelled ?? 0;
  for (let i = 0; i < issuedTotal; i += 1) {
    statuses.push(ISSUED_CYCLE[i % ISSUED_CYCLE.length]!);
    if (draftLeft > 0 && i % 3 === 0) {
      statuses.push("DRAFT");
      draftLeft -= 1;
    }
    if (cancelledLeft > 0 && i % 3 === 1) {
      statuses.push("CANCELLED");
      cancelledLeft -= 1;
    }
  }
  while (draftLeft-- > 0) statuses.push("DRAFT");
  while (cancelledLeft-- > 0) statuses.push("CANCELLED");

  const db = getAdminFirestore();
  // Far in the past: any createdAt-desc list another test reads puts its own
  // (new) rows first.
  const base = Date.parse("2001-01-01T00:00:00.000Z");
  const issuedRefs: string[] = []; // oldest -> newest
  const partnerRefs = new Set<string>();
  let batch = db.batch();
  let pending = 0;
  for (let i = 0; i < statuses.length; i += 1) {
    const status = statuses[i]!;
    const uid = assignmentsCollection().doc().id;
    const assignmentRef = generateAssignmentRef();
    const partnerRef = `bulk-partner-${runId}-${(plan.offset ?? 0) + i}`;
    const createdAt = new Date(base + ((plan.offset ?? 0) + i) * 1000).toISOString();
    const doc = assignmentDocSchema.parse({
      uid,
      assignmentRef,
      version: 1,
      campaignRef,
      partnerRef,
      partnerAccountRefs: [],
      status,
      statusReason: status === "CANCELLED" ? "Bulk fixture." : null,
      brief: assignmentBriefSchema.parse({ platforms: ["instagram"], reviewPolicy: campaign.defaultReviewPolicy, campaignName: campaign.name, campaignObjective: campaign.objective }),
      ownerUid: campaign.ownerUid,
      regionIds: plan.regionIds ?? campaign.regionIds,
      teamIds: campaign.teamIds,
      createdAt,
      createdByUserRef: "bulk-fixture",
      updatedAt: createdAt,
      updatedByUserRef: "bulk-fixture",
    });
    batch.set(assignmentsCollection().doc(uid), doc);
    bulkDocRefs.push(assignmentsCollection().doc(uid));
    pending += 1;
    if (ISSUED_CYCLE.includes(status)) {
      issuedRefs.push(assignmentRef);
      partnerRefs.add(partnerRef);
    }
    if (pending === 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();

  // Content threads on the newest issued Assignments.
  const threadStatuses = plan.threads ?? [];
  if (threadStatuses.length > 0) {
    const threadBatch = db.batch();
    threadStatuses.forEach((status, i) => {
      const assignmentRef = issuedRefs[issuedRefs.length - 1 - i]!;
      const uid = contentCollection().doc().id;
      const now = new Date(base + 10_000_000 + i * 1000).toISOString();
      const doc = contentDocSchema.parse({
        uid,
        contentRef: generateContentRef(),
        version: 1,
        assignmentRef,
        campaignRef,
        partnerRef: `bulk-thread-partner-${i}`,
        status,
        statusReason: status === "REVISION_REQUESTED" ? "Please fix." : null,
        currentRevisionNumber: status === "OPEN" ? 0 : 1,
        reviewedRevisionNumber: status === "UNDER_REVIEW" ? 1 : null,
        currentLinks: status === "OPEN" ? [] : [{ platform: "instagram", originalUrl: "https://example.com/p", normalizedUrl: "https://example.com/p", recordedAt: now }],
        qualifyingFulfillment: null,
        dueAt: null,
        openedAt: now,
        firstSubmittedAt: status === "OPEN" ? null : now,
        lastSubmittedAt: status === "OPEN" ? null : now,
        approvedAt: status === "APPROVED" ? now : null,
        cancelledAt: null,
        ownerUid: campaign.ownerUid,
        regionIds: plan.regionIds ?? campaign.regionIds,
        teamIds: campaign.teamIds,
        createdAt: now,
        createdByUserRef: "bulk-fixture",
        updatedAt: now,
        updatedByUserRef: "bulk-fixture",
      });
      threadBatch.set(contentCollection().doc(uid), doc);
      bulkDocRefs.push(contentCollection().doc(uid));
    });
    await threadBatch.commit();
  }
  return { issuedRefs, partnerRefs, rowsWritten: statuses.length };
}

const THREADS: ContentStatus[] = ["APPROVED", "UNDER_REVIEW", "REVISION_REQUESTED"];

async function summarize(actor: ActorContext, campaignRef: string) {
  const result = await getCampaignExecutionSummary(actor, campaignRef);
  if (!result.ok) throw new Error(`summary failed: ${result.message}`);
  return result.data;
}

describe("Campaign Overview obligations - cursor-followed pagination (Step 12C.2)", () => {
  it("the documented bound is 200 relevant obligations", () => {
    expect(MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY).toBe(200);
  });

  // ONE Campaign grown in stages (fewer bulk writes than one Campaign per size
  // - this file shares the emulator with every other file when run in
  // parallel). New rows are always the newest, so after the first stage the
  // three Content threads (on the newest Assignments of stage 1) stay inside
  // the kept 200 until the very last stage.
  it("101 -> 150 -> 200 relevant obligations are ALL represented (not truncated) even behind 120 DRAFT/CANCELLED rows; 201 and 260 keep exactly the newest 200 and report truncated; the Overview aggregate then carries the flags", async () => {
    const admin = await actorFor("super_admin");
    // ACTIVE from the start: the Overview aggregate is exercised at the end. Private region => only Super Admin sees it.
    const campaign = await createCampaignInState(admin, [PRIVATE_REGION], "ACTIVE");
    let written = 0;
    const stage = async (issued: number, threads?: ContentStatus[], irrelevant?: { draft: number; cancelled: number }) => {
      const result = await bulkWriteAssignments(campaign.campaignRef, { issued, draft: irrelevant?.draft, cancelled: irrelevant?.cancelled, threads, offset: written });
      written += result.rowsWritten;
    };

    // Stage 1: 101 relevant (the old single-page read stopped at 100) + 60 DRAFT + 60 CANCELLED.
    await stage(101, THREADS, { draft: 60, cancelled: 60 });
    const at101 = await summarize(admin, campaign.campaignRef);
    expect(at101.totalObligations).toBe(101);
    expect(at101.truncated).toBe(false);
    expect(at101.distinctPartnerCount).toBe(101);
    expect([at101.approvedCount, at101.underReviewCount, at101.revisionRequestedCount]).toEqual([1, 1, 1]);

    // Stage 2: 150.
    await stage(49);
    const at150 = await summarize(admin, campaign.campaignRef);
    expect(at150.totalObligations).toBe(150);
    expect(at150.truncated).toBe(false);

    // Stage 3: exactly 200 relevant - 320 rows scanned (4 pages): DRAFT/CANCELLED must not consume the 200 budget.
    await stage(50);
    const at200 = await summarize(admin, campaign.campaignRef);
    expect(at200.totalObligations).toBe(200);
    expect(at200.truncated).toBe(false);
    expect(at200.distinctPartnerCount).toBe(200);
    expect([at200.approvedCount, at200.underReviewCount, at200.revisionRequestedCount]).toEqual([1, 1, 1]);
    for (const summary of [at101, at150, at200]) {
      // Delivery-state segments reconcile exactly with the returned obligations.
      expect(summary.deliveryState.completed + summary.deliveryState.inProgress + summary.deliveryState.notStarted).toBe(summary.totalObligations);
    }

    // Stage 4: 201 relevant -> exactly 200 kept (the newest), truncated.
    await stage(1);
    const at201 = await summarize(admin, campaign.campaignRef);
    expect(at201.totalObligations).toBe(200);
    expect(at201.truncated).toBe(true);
    expect(at201.sourceLinksComplete).toBe(false); // never claimed over an incomplete set
    expect(at201.deliveryState.completed + at201.deliveryState.inProgress + at201.deliveryState.notStarted).toBe(200);
    expect([at201.approvedCount, at201.underReviewCount, at201.revisionRequestedCount]).toEqual([1, 1, 1]);

    // Stage 5: well over 200 (260) is still exactly 200 + truncated (bounded scan, not fetch-all).
    await stage(59);
    const at260 = await summarize(admin, campaign.campaignRef);
    expect(at260.totalObligations).toBe(200);
    expect(at260.truncated).toBe(true);

    // The portfolio Overview aggregate carries the flags; an exact Campaign stays exact.
    const small = await createCampaignInState(admin, [PRIVATE_REGION], "ACTIVE");
    await bulkWriteAssignments(small.campaignRef, { issued: 5 });
    const overview = await getCampaignExecutionOverview(admin);
    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    expect(overview.data.truncated).toBe(true);
    expect(overview.data.truncatedCampaignCount).toBeGreaterThanOrEqual(1);
    // The Overview lists only the 4 most recently updated Campaigns; when one of ours is listed its own flag is exact.
    for (const row of overview.data.perCampaignExecution) {
      if (row.campaignRef === campaign.campaignRef) expect(row).toMatchObject({ totalCount: 200, truncated: true });
      if (row.campaignRef === small.campaignRef) expect(row).toMatchObject({ totalCount: 5, truncated: false });
    }
    const { completed, inProgress, notStarted } = overview.data.deliveryState;
    expect(completed + inProgress + notStarted).toBe(overview.data.totalObligations);
  }, 120_000);

  it("the hard scan ceiling: 501 irrelevant-only rows (a sixth page exists) is reported truncated - never claimed empty/unstaffed", async () => {
    const admin = await actorFor("super_admin");
    const campaign = await createCampaignInState(admin, [PRIVATE_REGION], "PLANNED");
    await bulkWriteAssignments(campaign.campaignRef, { issued: 0, draft: 251, cancelled: 250 });
    const summary = await summarize(admin, campaign.campaignRef);
    expect(summary.totalObligations).toBe(0);
    expect(summary.truncated).toBe(true);
  }, 60_000);

  it("scope is applied BEFORE inclusion: out-of-scope Assignments are neither shown nor counted", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    // Manager may read this Kerala Campaign, but 110 of its Assignments carry a
    // private-region scope snapshot (outside Manager's grants) and 30 carry
    // Kerala. PLANNED, so it is in no ACTIVE portfolio scan anywhere.
    const campaign = await createCampaignInState(manager, ["Kerala"], "PLANNED");
    const first = await bulkWriteAssignments(campaign.campaignRef, { issued: 110, regionIds: [PRIVATE_REGION] });
    await bulkWriteAssignments(campaign.campaignRef, { issued: 30, offset: first.rowsWritten });

    const forManager = await summarize(manager, campaign.campaignRef);
    expect(forManager.totalObligations).toBe(30);
    expect(forManager.truncated).toBe(false);

    const forAdmin = await summarize(admin, campaign.campaignRef);
    expect(forAdmin.totalObligations).toBe(140); // GLOBAL sees all 140 (both pages)
    expect(forAdmin.truncated).toBe(false);
  }, 90_000);

  it("a Campaign outside the actor's scope is denied outright - no obligations, no counts", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    // ACTIVE on purpose (so the Manager's Overview would list it if scope leaked)
    // - but in the private region, so only Super Admin ever sees it.
    const outside = await createCampaignInState(admin, [PRIVATE_REGION], "ACTIVE");
    await bulkWriteAssignments(outside.campaignRef, { issued: 30 });
    const result = await getCampaignExecutionSummary(manager, outside.campaignRef);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unauthorized");

    const overview = await getCampaignExecutionOverview(manager);
    expect(overview.ok).toBe(true);
    if (overview.ok) expect(overview.data.perCampaignExecution.some((row) => row.campaignRef === outside.campaignRef)).toBe(false);
  }, 60_000);
});

describe("Campaign Detail downstream summary shares the same bound (Step 12C.2)", () => {
  it("CANCELLED Assignments no longer consume the 200 budget (190 issued + 30 cancelled is exact); more than 200 non-cancelled is 200 + truncated (DRAFT counts, CANCELLED does not)", async () => {
    const admin = await actorFor("super_admin");
    const campaign = await createCampaignInState(admin, [PRIVATE_REGION], "PLANNED");
    const first = await bulkWriteAssignments(campaign.campaignRef, { issued: 190, cancelled: 30 });
    const exact = await getCampaignDownstreamSummary(admin, campaign.campaignRef);
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(exact.data.assignments).toEqual({ available: true, total: 190, draftCount: 0, issuedCount: 190, distinctPartnerCount: 190, truncated: false });

    // 190 + 5 issued + 20 DRAFT = 215 non-cancelled (plus the 30 cancelled): 200 counted, truncated.
    await bulkWriteAssignments(campaign.campaignRef, { issued: 5, draft: 20, threads: THREADS, offset: first.rowsWritten });
    const over = await getCampaignDownstreamSummary(admin, campaign.campaignRef);
    expect(over.ok).toBe(true);
    if (!over.ok) return;
    expect(over.data.assignments).toMatchObject({ available: true, total: 200, truncated: true });
    if (over.data.assignments.available) expect(over.data.assignments.draftCount + over.data.assignments.issuedCount).toBe(200);
    if (over.data.content.available) expect(over.data.content.truncated).toBe(true);
  }, 90_000);
});
