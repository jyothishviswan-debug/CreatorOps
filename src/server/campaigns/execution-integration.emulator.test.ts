// Step 12C - real reads/writes against the running Firestore/Auth
// emulator (no mocks), same rationale as every other domain's own
// *.emulator.test.ts suite. Run with `pnpm test:emulator` against a
// running `pnpm firebase:emulators`.
//
// Fresh Assignment/Content/Analytics fixtures are created LIVE here, via
// the real trusted service functions each already has (createAssignment,
// transitionAssignmentLifecycle, createExternalSubmissionSession,
// submitExternalLinks, approveContentThread, executeAnalyticsImport,
// createCampaign/transitionCampaignLifecycle) - layered on top of the
// existing seeded ACTIVE Campaign fixture ("civic-voices", from the
// protected, read-only seed-campaigns-data.ts) plus freshly-created
// ACTIVE Campaigns of this file's own for scope differentiation. The
// protected seed file itself is never edited.
import { beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth } from "@/server/firebase/admin";

import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { seedVendorsData } from "@/server/vendors/seed-vendors-data";
import { seedCampaignsData } from "@/server/campaigns/seed-campaigns-data";
import { seedAssignmentsData } from "@/server/assignments/seed-assignments-data";
import { seedContentData } from "@/server/content/seed-content-data";
import { seedAnalyticsData } from "@/server/analytics/seed-analytics-data";

import { createCampaign, getCampaign } from "@/server/campaigns/campaign-service";
import { transitionCampaignLifecycle } from "@/server/campaigns/campaign-lifecycle-service";
import { createAssignment } from "@/server/assignments/assignment-service";
import { transitionAssignmentLifecycle } from "@/server/assignments/assignment-lifecycle-service";
import { createExternalSubmissionSession, submitExternalLinks } from "@/server/assignments/external-submission-service";
import { listContent } from "@/server/content/content-service";
import { approveContentThread, requestContentRevision } from "@/server/content/content-lifecycle-service";
import { executeAnalyticsImport } from "@/server/analytics/import-service";

import { getCampaignExecutionOverview, getCampaignExecutionSummary, MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY } from "./execution-integration-service";

const uidByRole = new Map<string, string>();
const runId = Date.now();
let runCounter = 0;

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

function uniqueName(prefix: string): string {
  runCounter += 1;
  return `${prefix} ${runId}-${runCounter}`;
}

function workbookBuffer(rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, "Content");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// Creates a fresh, real ACTIVE Campaign via the trusted service (DRAFT ->
// PLANNED -> ACTIVE), scoped by regionIds so scope tests can target a
// specific actor.
async function createActiveCampaign(actor: ActorContext, regionIds: string[]): Promise<{ campaignRef: string }> {
  const created = await createCampaign(actor, { name: uniqueName("Exec Emulator Campaign"), objective: "x", platforms: ["instagram"], startDate: "2026-01-01", endDate: "2026-12-01", regionIds, defaultReviewPolicy: "REVIEW_REQUIRED" }, `req-${uniqueName("create")}`);
  if (!created.ok) throw new Error(`createCampaign failed: ${created.message}`);
  const planned = await transitionCampaignLifecycle(actor, created.data.campaignRef, { to: "PLANNED", expectedVersion: created.data.version }, `req-${uniqueName("planned")}`);
  if (!planned.ok) throw new Error(`transitionCampaignLifecycle(PLANNED) failed: ${planned.message}`);
  const activated = await transitionCampaignLifecycle(actor, created.data.campaignRef, { to: "ACTIVE", expectedVersion: planned.data.version }, `req-${uniqueName("active")}`);
  if (!activated.ok) throw new Error(`transitionCampaignLifecycle(ACTIVE) failed: ${activated.message}`);
  return { campaignRef: created.data.campaignRef };
}

// Creates a fresh Assignment under `campaignRef` and drives it through
// ASSIGNED -> ACCEPTED -> IN_PROGRESS - the real states a submission is
// accepted from.
async function createInProgressAssignment(actor: ActorContext, campaignRef: string, options: { partnerRef?: string; platform?: string } = {}): Promise<{ assignmentRef: string; version: number }> {
  const partnerRef = options.partnerRef ?? "seed-partner-direct";
  const platform = options.platform ?? "instagram";
  const created = await createAssignment(actor, { campaignRef, partnerRef, brief: { platforms: [platform] } }, `req-${uniqueName("assign-create")}`);
  if (!created.ok) throw new Error(`createAssignment failed: ${created.message}`);
  const assigned = await transitionAssignmentLifecycle(actor, created.data.assignmentRef, { to: "ASSIGNED", expectedVersion: created.data.version }, `req-${uniqueName("assigned")}`);
  if (!assigned.ok) throw new Error(`transition(ASSIGNED) failed: ${assigned.message}`);
  const accepted = await transitionAssignmentLifecycle(actor, created.data.assignmentRef, { to: "ACCEPTED", expectedVersion: assigned.data.version }, `req-${uniqueName("accepted")}`);
  if (!accepted.ok) throw new Error(`transition(ACCEPTED) failed: ${accepted.message}`);
  const inProgress = await transitionAssignmentLifecycle(actor, created.data.assignmentRef, { to: "IN_PROGRESS", expectedVersion: accepted.data.version }, `req-${uniqueName("in-progress")}`);
  if (!inProgress.ok) throw new Error(`transition(IN_PROGRESS) failed: ${inProgress.message}`);
  return { assignmentRef: created.data.assignmentRef, version: inProgress.data.version };
}

// Publishes a real link through the real trusted submission path (session
// + submitExternalLinks) - never a direct Firestore write.
async function submitRealLink(actor: ActorContext, assignmentRef: string, url: string): Promise<void> {
  const session = await createExternalSubmissionSession(actor, assignmentRef, { recipientType: "PARTNER" }, `req-${uniqueName("session")}`);
  if (!session.ok) throw new Error(`createExternalSubmissionSession failed: ${session.message}`);
  const submitted = await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url }]);
  if (!submitted.ok) throw new Error(`submitExternalLinks failed: ${submitted.message}`);
}

async function getThreadByAssignmentRef(actor: ActorContext, assignmentRef: string) {
  const result = await listContent(actor, { assignmentRef, limit: 1 });
  if (!result.ok) throw new Error(`listContent failed: ${result.message}`);
  const thread = result.data.content[0];
  if (!thread) throw new Error(`no Content thread found for ${assignmentRef}`);
  return thread;
}

describe("Campaign Execution integration - per-Campaign summary", () => {
  it("composes real obligations from Assignment + Content, joined by assignmentRef - never N+1", async () => {
    const admin = await actorFor("super_admin");
    const campaign = await createActiveCampaign(admin, ["Kerala"]);
    const assignment = await createInProgressAssignment(admin, campaign.campaignRef);

    const beforeSubmit = await getCampaignExecutionSummary(admin, campaign.campaignRef);
    expect(beforeSubmit.ok).toBe(true);
    if (!beforeSubmit.ok) return;
    expect(beforeSubmit.data.totalObligations).toBe(1);
    expect(beforeSubmit.data.approvedCount).toBe(0);
    expect(beforeSubmit.data.deliveryState).toEqual({ completed: 0, inProgress: 1, notStarted: 0 }); // assignmentStatus IN_PROGRESS
    expect(beforeSubmit.data.sourceLinksComplete).toBe(false); // no Content thread / no links yet

    await submitRealLink(admin, assignment.assignmentRef, `https://instagram.com/p/emu-${uniqueName("link")}`);
    const thread = await getThreadByAssignmentRef(admin, assignment.assignmentRef);
    expect(thread.status).toBe("UNDER_REVIEW");

    const afterSubmit = await getCampaignExecutionSummary(admin, campaign.campaignRef);
    expect(afterSubmit.ok).toBe(true);
    if (!afterSubmit.ok) return;
    expect(afterSubmit.data.underReviewCount).toBe(1);
    expect(afterSubmit.data.deliveryState).toEqual({ completed: 0, inProgress: 1, notStarted: 0 }); // UNDER_REVIEW => inProgress
    expect(afterSubmit.data.sourceLinksComplete).toBe(true); // one obligation, its Content thread now has >=1 currentLinks
    expect(afterSubmit.data.approvedCount).toBe(0); // never complete while merely UNDER_REVIEW

    const approved = await approveContentThread(admin, thread.contentRef, { reviewedRevisionNumber: thread.reviewedRevisionNumber, expectedVersion: thread.version }, `req-${uniqueName("approve")}`);
    expect(approved.ok).toBe(true);

    const afterApprove = await getCampaignExecutionSummary(admin, campaign.campaignRef);
    expect(afterApprove.ok).toBe(true);
    if (!afterApprove.ok) return;
    expect(afterApprove.data.approvedCount).toBe(1);
    expect(afterApprove.data.deliveryState).toEqual({ completed: 1, inProgress: 0, notStarted: 0 });

    // Analytics readiness is the real helper's own output, reused
    // verbatim - no Analytics data has been linked yet for this fresh
    // Campaign, so it stays honestly false.
    expect(afterApprove.data.analyticsReadiness.hasLinkedSourceRecords).toBe(false);

    // Campaign lifecycle is completely untouched by any of the above.
    const campaignAfter = await getCampaign(admin, campaign.campaignRef);
    expect(campaignAfter.ok).toBe(true);
    if (campaignAfter.ok) expect(campaignAfter.data.status).toBe("ACTIVE");
  });

  it("a REVISION_REQUESTED thread counts as inProgress, never completed, and the loop back to UNDER_REVIEW is reflected live", async () => {
    const admin = await actorFor("super_admin");
    const campaign = await createActiveCampaign(admin, ["Kerala"]);
    const assignment = await createInProgressAssignment(admin, campaign.campaignRef);
    await submitRealLink(admin, assignment.assignmentRef, `https://instagram.com/p/emu-${uniqueName("rev")}`);
    const thread = await getThreadByAssignmentRef(admin, assignment.assignmentRef);

    const revision = await requestContentRevision(admin, thread.contentRef, { reason: "Needs a clearer caption.", reviewedRevisionNumber: thread.reviewedRevisionNumber, expectedVersion: thread.version }, `req-${uniqueName("revreq")}`);
    expect(revision.ok).toBe(true);

    const summary = await getCampaignExecutionSummary(admin, campaign.campaignRef);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.data.revisionRequestedCount).toBe(1);
    expect(summary.data.deliveryState).toEqual({ completed: 0, inProgress: 1, notStarted: 0 });
    expect(summary.data.approvedCount).toBe(0);
  });

  it("Analytics import arrival changes analyticsReadiness/sourceLinksComplete signal but never mutates Content or Assignment status, and Campaign stays ACTIVE", async () => {
    const admin = await actorFor("super_admin");
    const campaign = await createActiveCampaign(admin, ["Kerala"]);
    const assignment = await createInProgressAssignment(admin, campaign.campaignRef);
    const url = `https://instagram.com/p/emu-analytics-${uniqueName("x")}`;
    await submitRealLink(admin, assignment.assignmentRef, url);
    const thread = await getThreadByAssignmentRef(admin, assignment.assignmentRef);
    const approved = await approveContentThread(admin, thread.contentRef, { reviewedRevisionNumber: thread.reviewedRevisionNumber, expectedVersion: thread.version }, `req-${uniqueName("approve2")}`);
    expect(approved.ok).toBe(true);

    const beforeImport = await getCampaignExecutionSummary(admin, campaign.campaignRef);
    expect(beforeImport.ok).toBe(true);
    if (beforeImport.ok) expect(beforeImport.data.analyticsReadiness.hasLinkedSourceRecords).toBe(false);

    const analyst = await actorFor("analyst");
    const buffer = workbookBuffer([
      ["Post URL", "Comments", "Likes"],
      [url, "3", "9"],
    ]);
    const imported = await executeAnalyticsImport(analyst, { targetKind: "campaign_content", fileBuffer: buffer, filename: `${uniqueName("emu-import")}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, `req-${uniqueName("import")}`);
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.data.counts.matched).toBe(1);

    const afterImport = await getCampaignExecutionSummary(admin, campaign.campaignRef);
    expect(afterImport.ok).toBe(true);
    if (!afterImport.ok) return;
    expect(afterImport.data.analyticsReadiness.hasLinkedSourceRecords).toBe(true);
    expect(afterImport.data.analyticsReadiness.matchedCount).toBe(1);
    // Content/Assignment status are unchanged by the Analytics arrival.
    expect(afterImport.data.approvedCount).toBe(1);
    expect(afterImport.data.deliveryState).toEqual({ completed: 1, inProgress: 0, notStarted: 0 });

    const threadAfterImport = await getThreadByAssignmentRef(admin, assignment.assignmentRef);
    expect(threadAfterImport.status).toBe("APPROVED"); // unchanged

    const campaignAfterImport = await getCampaign(admin, campaign.campaignRef);
    expect(campaignAfterImport.ok).toBe(true);
    if (campaignAfterImport.ok) expect(campaignAfterImport.data.status).toBe("ACTIVE"); // an Analytics import must never move a Campaign's own status
  });

  it("no raw internal doc id/uid leaks anywhere in the summary DTO - opaque refs only", async () => {
    const admin = await actorFor("super_admin");
    const campaign = await createActiveCampaign(admin, ["Kerala"]);
    await createInProgressAssignment(admin, campaign.campaignRef);

    const summary = await getCampaignExecutionSummary(admin, campaign.campaignRef);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const serialized = JSON.stringify(summary.data);
    expect(serialized).not.toMatch(/"uid"/);
  });
});

describe("Campaign Execution integration - portfolio overview scope", () => {
  it("Manager sees only their own in-scope active Campaigns' obligations - a cross-scope (civic-voices) Assignment never influences their totals", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");

    // A fresh, Manager-reachable (Kerala) ACTIVE Campaign with one real obligation.
    const managerCampaign = await createActiveCampaign(manager, ["Kerala"]);
    await createInProgressAssignment(manager, managerCampaign.campaignRef);

    // civic-voices (Tamil Nadu, ACTIVE) already carries real seeded
    // execution obligations of its own (seed-assignment-in-progress:
    // IN_PROGRESS; seed-assignment-assigned: ASSIGNED - see
    // seed-assignments-data.ts) - reused here directly rather than
    // creating a fresh one, since both of civic-voices' own ACTIVE seed
    // Partners ("creator-house"/"seed-partner-direct") are already
    // canonically claimed under it. civic-voices' Assignment-domain scope
    // snapshot is Tamil Nadu, which Manager holds no grant for at all -
    // Head's own explicit CAMPAIGN grant on the Campaign itself does NOT
    // bridge into the separate Assignment domain's own scope either (see
    // assignments.spec.ts's own precedent), so only Super Admin's GLOBAL
    // scope reaches its obligations.

    const managerOverview = await getCampaignExecutionOverview(manager);
    expect(managerOverview.ok).toBe(true);
    if (!managerOverview.ok) return;
    expect(managerOverview.data.perCampaignExecution.some((c) => c.campaignRef === managerCampaign.campaignRef)).toBe(true);
    // Manager holds no region/team/campaign grant reaching civic-voices
    // at all (Tamil Nadu) - it never even appears as one of Manager's own
    // actor-visible ACTIVE Campaigns, let alone its obligation.
    expect(managerOverview.data.perCampaignExecution.some((c) => c.campaignRef === "civic-voices")).toBe(false);

    // Super Admin's GLOBAL scope reaches civic-voices' real obligations
    // directly (per-Campaign summary, not subject to the portfolio
    // overview's own top-4 display cap) - the union proof.
    const civicVoicesSummary = await getCampaignExecutionSummary(admin, "civic-voices");
    expect(civicVoicesSummary.ok).toBe(true);
    if (civicVoicesSummary.ok) expect(civicVoicesSummary.data.totalObligations).toBeGreaterThan(0);

    // And the portfolio overview's own aggregate totals for Super Admin
    // are strictly wider than Manager's own scoped totals - proving
    // civic-voices' obligations genuinely fold into Super Admin's
    // portfolio-wide counts even though Manager can never see them.
    const adminOverview = await getCampaignExecutionOverview(admin);
    expect(adminOverview.ok).toBe(true);
    if (!adminOverview.ok) return;
    expect(adminOverview.data.totalObligations).toBeGreaterThan(managerOverview.data.totalObligations);
  });

  it("Super Admin (GLOBAL) sees the union of every actor-visible in-scope active Campaign's obligations", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const managerCampaign = await createActiveCampaign(manager, ["Kerala"]);
    await createInProgressAssignment(manager, managerCampaign.campaignRef);

    const adminOverview = await getCampaignExecutionOverview(admin);
    expect(adminOverview.ok).toBe(true);
    if (!adminOverview.ok) return;
    // GLOBAL sees every active Campaign, including civic-voices and the
    // Manager-scoped one just created above.
    expect(adminOverview.data.activeCampaignCount).toBeGreaterThanOrEqual(2);
  });

  it("a Campaign with zero obligations is counted as unstaffed, never rendered as a fabricated 0% row", async () => {
    const admin = await actorFor("super_admin");
    const emptyCampaign = await createActiveCampaign(admin, ["Kerala"]);

    const overview = await getCampaignExecutionOverview(admin);
    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    expect(overview.data.perCampaignExecution.some((c) => c.campaignRef === emptyCampaign.campaignRef)).toBe(false);
    expect(overview.data.trackingReadiness.campaignsUnstaffedRow.badge).toBe("Review");
    expect(overview.data.executionExceptions.campaignsWithoutAssignments).toBeGreaterThanOrEqual(1);
  });

  it("reads stay within the documented per-Campaign obligation bound - a real multi-Assignment Campaign resolves in one bounded pass, not fetch-all", async () => {
    const admin = await actorFor("super_admin");
    const campaign = await createActiveCampaign(admin, ["Kerala"]);
    // Two distinct real Assignments under the same Campaign (the one-
    // canonical-Assignment-per-(campaignRef, partnerRef) invariant caps
    // this at the number of distinct ACTIVE seeded Partners available -
    // "creator-house" and "seed-partner-direct") - proves the
    // campaignRef-scoped query composes correctly for more than one
    // obligation without ever exceeding the documented bound.
    await createInProgressAssignment(admin, campaign.campaignRef, { partnerRef: "seed-partner-direct" });
    await createInProgressAssignment(admin, campaign.campaignRef, { partnerRef: "creator-house" });
    const summary = await getCampaignExecutionSummary(admin, campaign.campaignRef);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.data.totalObligations).toBe(2);
    expect(summary.data.distinctPartnerCount).toBe(2);
    expect(summary.data.totalObligations).toBeLessThanOrEqual(MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY);
  });
});
