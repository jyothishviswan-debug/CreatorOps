// Step 19A - Reports against the running Firestore/Auth emulator, end to end, on REAL records and
// through every real source module's own gate (never mocked).
//
// Proven here (section 23's own "at minimum" list):
//   - Catalog visibility across all five roles.
//   - Role matrix for the full run vs the Viewer-safe run (section 8/17): Viewer holds no
//     run_reports action and is denied the full run, but IS sanctioned for viewer-run; Viewer-safe
//     run additionally refuses Finance Status / Administration & Security outright for every role.
//   - Record scope (section 8): a Partner outside an actor's own region grants never appears in that
//     actor's Partner Portfolio rows, even though Super Admin (GLOBAL) sees it.
//   - Campaign Delivery, Partner Review Evidence, Operations Attention exercised against REAL
//     Campaign+Assignment+Content, a REAL finalized Partner Review, and a REAL Task respectively.
//   - Campaign Performance and Finance Status exercised end to end against the real gate/composition
//     path (no Analytics/Finance fixture data exists in this seed, so rows are legitimately empty -
//     what's certified here is real actor resolution, real per-source FeatureAccess gating, and the
//     bounded ReportResult contract, not row-mapping against populated data).
//   - Bounded execution: every result's rowCount <= maxRows, truncated is a boolean, generatedAt and
//     evidenceCutoff are both present.
//   - Finalized snapshot (section 15): finalize -> immutable get, invisible to a different actor.
//   - Step 19A.1: the four management-scale families (Monthly Partner Performance, Campaign / Event
//     Performance, Cross-Platform Partner / Programme, Long-Period Partner Programme) exercised end to
//     end with real execution - never a stub, never "unsupported".
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTask } from "@/server/operations";
import { operationsTasksCollection } from "@/server/operations/firestore";
import { resolveActor } from "@/server/authz/actor";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { createAssignment } from "@/server/assignments/assignment-service";
import { assignmentsCollection } from "@/server/assignments/firestore";
import { createCampaign } from "@/server/campaigns/campaign-service";
import { campaignsCollection } from "@/server/campaigns/firestore";
import { transitionCampaignLifecycle } from "@/server/campaigns/campaign-lifecycle-service";
import { resolveOrCreateContentThread } from "@/server/content/content-service";
import { contentCollection } from "@/server/content/firestore";
import { getAdminFirestore } from "@/server/firebase/admin";
import { finalizePartnerReview, submitPartnerReviewForReview } from "@/server/partner-reviews/partner-review-lifecycle-service";
import { partnerReviewsCollection } from "@/server/partner-reviews/firestore";
import { generatePartnerReviewDraft } from "@/server/partner-reviews/partner-review-service";
import { createPartner } from "@/server/partners/partner-service";
import { partnersCollection } from "@/server/partners/firestore";

import { reportSnapshotsCollection } from "./firestore";
import { getReportDefinitionForActor, listReportCatalogForActor, runReport } from "./report-service";
import { finalizeReport, getFinalizedSnapshot } from "./snapshot-service";
import type { ReportsServiceResult } from "./types";

vi.setConfig({ testTimeout: 60_000 });

const runId = Date.now();
const PERIOD = "2026-06";
const uidByRole = new Map<string, string>();
let reqCounter = 0;
const requestId = () => `rpt-req-${runId}-${(reqCounter += 1)}`;

const campaignRefs: string[] = [];
const assignmentRefs: string[] = [];
const contentRefs: string[] = [];
const partnerRefs: string[] = [];
const reviewRefs: string[] = [];
const taskRefs: string[] = [];
const snapshotRefs: string[] = [];

async function actorFor(role: string): Promise<ActorContext> {
  const actor = await resolveActor(uidByRole.get(role)!);
  if (!actor) throw new Error(`no seeded actor for ${role}`);
  return actor;
}

function must<T>(result: ReportsServiceResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}`);
  return result.data;
}

function failure<T>(result: ReportsServiceResult<T>) {
  if (result.ok) throw new Error("expected a failure, got a success");
  return result;
}

let fixtures: { campaignRef: string; assignmentRef: string; contentRef: string; keralaPartnerRef: string; delhiPartnerRef: string; finalizedReviewRef: string; taskRef: string };

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  for (const identity of TEST_IDENTITIES) {
    const { getAdminAuth } = await import("@/server/firebase/admin");
    const user = await getAdminAuth().getUserByEmail(identity.email);
    uidByRole.set(identity.role, user.uid);
  }

  const manager = await actorFor("partnership_manager");
  const head = await actorFor("partnership_head");

  // Campaign Delivery fixture: a real Campaign -> Assignment -> Content chain.
  const campaign = await createCampaign(manager, { name: `Reports Fixture Campaign ${runId}`, objective: "Certify Campaign Delivery", startDate: "2026-01-01", endDate: "2026-12-31", defaultReviewPolicy: "NO_PREPOST_REVIEW", regionIds: ["Kerala"], platforms: ["instagram"] }, requestId());
  if (!campaign.ok) throw new Error(`createCampaign failed: ${campaign.code} - ${campaign.message}`);
  campaignRefs.push(campaign.data.campaignRef);

  // An Assignment may only be created once the Campaign has left DRAFT.
  const planned = await transitionCampaignLifecycle(manager, campaign.data.campaignRef, { to: "PLANNED", expectedVersion: campaign.data.version }, requestId());
  if (!planned.ok) throw new Error(`transitionCampaignLifecycle(PLANNED) failed: ${planned.code} - ${planned.message}${"blockers" in planned ? ` blockers=${JSON.stringify((planned as { blockers?: unknown }).blockers)}` : ""}`);

  const keralaPartner = await createPartner(head, { displayName: `Reports Fixture Partner Kerala ${runId}`, regionIds: ["Kerala"] }, requestId());
  if (!keralaPartner.ok) throw new Error(`createPartner (Kerala) failed: ${keralaPartner.code} - ${keralaPartner.message}`);
  partnerRefs.push((keralaPartner.data as { partnerRef: string }).partnerRef);

  // Delhi (North Zone) is outside every seeded role's own region grants except Super Admin's GLOBAL
  // - the record-scope leak test's control fixture.
  const delhiPartner = await createPartner(head, { displayName: `Reports Fixture Partner Delhi ${runId}`, regionIds: ["Delhi"] }, requestId());
  if (!delhiPartner.ok) throw new Error(`createPartner (Delhi) failed: ${delhiPartner.code} - ${delhiPartner.message}`);
  partnerRefs.push((delhiPartner.data as { partnerRef: string }).partnerRef);

  const assignment = await createAssignment(manager, { campaignRef: campaign.data.campaignRef, partnerRef: (keralaPartner.data as { partnerRef: string }).partnerRef }, requestId());
  if (!assignment.ok) throw new Error(`createAssignment failed: ${assignment.code} - ${assignment.message}`);
  assignmentRefs.push(assignment.data.assignmentRef);

  const contentDoc = await resolveOrCreateContentThread(assignment.data.assignmentRef, manager.userRef, requestId());
  contentRefs.push(contentDoc.contentRef);

  // Partner Review Evidence fixture: a real FINALIZED review.
  const draft = await generatePartnerReviewDraft(manager, { partnerRef: (keralaPartner.data as { partnerRef: string }).partnerRef, periodKey: PERIOD }, requestId());
  if (!draft.ok) throw new Error(`generatePartnerReviewDraft failed: ${draft.code} - ${draft.message}`);
  const reviewRef = draft.data.review.head.reviewRef;
  reviewRefs.push(reviewRef);
  const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: 1 }, requestId());
  if (!submitted.ok) throw new Error(`submitPartnerReviewForReview failed: ${submitted.code} - ${submitted.message}`);
  const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: 2 }, requestId());
  if (!finalized.ok) throw new Error(`finalizePartnerReview failed: ${finalized.code} - ${finalized.message}`);

  // Operations Attention fixture: a real open Task, carrying the Kerala region so BOTH Manager
  // (via SELF, as its assignee) and Head (via the REGION grant every seeded Head identity holds)
  // can see it - Head has no SELF/creator relationship to a Task it did not create/is not assigned.
  const task = await createTask(manager, { title: `Reports Fixture Task ${runId}`, target: { targetType: "PARTNER", targetRef: (keralaPartner.data as { partnerRef: string }).partnerRef }, assigneeUserRef: manager.userRef, priority: "HIGH", regionIds: ["Kerala"] }, requestId());
  if (!task.ok) throw new Error(`createTask failed: ${task.code} - ${task.message}`);
  taskRefs.push(task.data.taskRef);

  fixtures = {
    campaignRef: campaign.data.campaignRef,
    assignmentRef: assignment.data.assignmentRef,
    contentRef: contentDoc.contentRef,
    keralaPartnerRef: (keralaPartner.data as { partnerRef: string }).partnerRef,
    delhiPartnerRef: (delhiPartner.data as { partnerRef: string }).partnerRef,
    finalizedReviewRef: reviewRef,
    taskRef: task.data.taskRef,
  };
}, 120_000);

afterAll(async () => {
  const db = getAdminFirestore();
  for (const ref of contentRefs) {
    const snap = await contentCollection().where("contentRef", "==", ref).limit(1).get();
    if (!snap.empty) await db.recursiveDelete(snap.docs[0]!.ref);
  }
  for (const ref of assignmentRefs) {
    const snap = await assignmentsCollection().where("assignmentRef", "==", ref).limit(1).get();
    if (!snap.empty) await db.recursiveDelete(snap.docs[0]!.ref);
  }
  for (const ref of campaignRefs) {
    const snap = await campaignsCollection().where("campaignRef", "==", ref).limit(1).get();
    if (!snap.empty) await db.recursiveDelete(snap.docs[0]!.ref);
  }
  for (const ref of reviewRefs) await db.recursiveDelete(partnerReviewsCollection().doc(ref));
  for (const ref of taskRefs) await db.recursiveDelete(operationsTasksCollection().doc(ref));
  for (const ref of partnerRefs) {
    const snap = await partnersCollection().where("partnerRef", "==", ref).limit(1).get();
    if (!snap.empty) await db.recursiveDelete(snap.docs[0]!.ref);
  }
  for (const ref of snapshotRefs) await db.recursiveDelete(reportSnapshotsCollection().doc(ref));
});

// ==================================================================================================
describe("Catalog visibility (section 4/22)", () => {
  it("every one of the five roles can see the governed catalog - view is broad", async () => {
    for (const role of ["viewer", "analyst", "partnership_manager", "partnership_head", "super_admin"]) {
      const actor = await actorFor(role);
      const list = must(await listReportCatalogForActor(actor), role);
      expect(list.length, role).toBe(13);
    }
  });

  it("an unauthenticated actor (null) is denied the catalog with not_authenticated", async () => {
    const result = failure(await listReportCatalogForActor(null));
    expect(result.code).toBe("unauthorized");
    expect(result.reason).toBe("not_authenticated");
  });

  it("getReportDefinitionForActor returns not_found for an unknown report id", async () => {
    const viewer = await actorFor("viewer");
    const result = failure(await getReportDefinitionForActor(viewer, "not_a_real_report"));
    expect(result.code).toBe("not_found");
  });
});

// ==================================================================================================
describe("Role matrix - the full run requires run_reports (section 8/17)", () => {
  it("Viewer is denied the full run of a report Viewer would otherwise be scoped to see (discovery has feature access, but no run_reports action)", async () => {
    const viewer = await actorFor("viewer");
    const result = failure(await runReport(viewer, "discovery_funnel", undefined, {}));
    expect(result.code).toBe("unauthorized");
    expect(result.reason).toBe("action_denied");
  });

  it("Viewer IS sanctioned for the Viewer-safe run of the same report", async () => {
    const viewer = await actorFor("viewer");
    const result = must(await runReport(viewer, "discovery_funnel", undefined, { viewerSafe: true }), "viewer viewer-run discovery_funnel");
    expect(result.reportId).toBe("discovery_funnel");
    expect(result.provenance).toEqual([]); // internal provenance detail is stripped on the Viewer-safe path
  });

  it("Analyst/Manager/Head/Super Admin can all run the full discovery_funnel report (each holds run_reports + the discovery feature)", async () => {
    for (const role of ["analyst", "partnership_manager", "partnership_head", "super_admin"]) {
      const actor = await actorFor(role);
      const result = must(await runReport(actor, "discovery_funnel", undefined, {}), role);
      expect(result.reportId, role).toBe("discovery_funnel");
    }
  });

  it("Viewer is denied operations_attention with action_denied (Viewer never holds run_reports at all, regardless of report)", async () => {
    const viewer = await actorFor("viewer");
    const result = failure(await runReport(viewer, "operations_attention", undefined, {}));
    expect(result.code).toBe("unauthorized");
    expect(result.reason).toBe("action_denied");
  });

  it("Analyst holds run_reports but lacks the 'operations' source feature - operations_attention is denied with scope_denied specifically (a DIFFERENT denial reason than Viewer's)", async () => {
    const analyst = await actorFor("analyst");
    const result = failure(await runReport(analyst, "operations_attention", undefined, {}));
    expect(result.code).toBe("unauthorized");
    expect(result.reason).toBe("scope_denied");
  });

  it("Manager/Head/Super Admin (all hold the 'operations' feature) can all run operations_attention successfully", async () => {
    for (const role of ["partnership_manager", "partnership_head", "super_admin"]) {
      const actor = await actorFor(role);
      const result = must(await runReport(actor, "operations_attention", undefined, {}), role);
      expect(result.reportId, role).toBe("operations_attention");
    }
  });

  it("Manager (the fixture Task's own assignee) sees it via listTasks' bounded SELF-only default query; Super Admin (GLOBAL scope) sees it via the bounded global scan too", async () => {
    // Operations' own listTasks deliberately never issues a region/team-scoped Firestore query with
    // no assignee/target filter (section 12/18's own 'never an unscoped scan' bound) - a non-global
    // actor with no filter always sees only their OWN assigned Tasks. This is Operations' own
    // established, accepted bounded-query design (see task-service.ts's listTasks) - Reports composes
    // it as-is, never widening it.
    for (const role of ["partnership_manager", "super_admin"]) {
      const actor = await actorFor(role);
      const result = must(await runReport(actor, "operations_attention", undefined, {}), role);
      expect(result.rows.some((row) => row.ref === fixtures.taskRef), role).toBe(true);
    }
  });

  it("Viewer is denied finance_status with action_denied (no run_reports)", async () => {
    const viewer = await actorFor("viewer");
    const result = failure(await runReport(viewer, "finance_status", undefined, {}));
    expect(result.code).toBe("unauthorized");
    expect(result.reason).toBe("action_denied");
  });

  it("Analyst holds run_reports but lacks the 'finance' feature - finance_status is denied with scope_denied", async () => {
    const analyst = await actorFor("analyst");
    const result = failure(await runReport(analyst, "finance_status", undefined, {}));
    expect(result.code).toBe("unauthorized");
    expect(result.reason).toBe("scope_denied");
  });

  it("Manager/Head/Super Admin (all hold 'finance') can run finance_status - real gate, real composition, contract holds even with empty Finance fixture data", async () => {
    for (const role of ["partnership_manager", "partnership_head", "super_admin"]) {
      const actor = await actorFor(role);
      const result = must(await runReport(actor, "finance_status", undefined, {}), role);
      expect(result.reportId, role).toBe("finance_status");
      expect(typeof result.metrics.activeAgreementCount, role).toBe("number");
    }
  });

  it("Viewer is denied administration_security with action_denied (no run_reports)", async () => {
    const viewer = await actorFor("viewer");
    const result = failure(await runReport(viewer, "administration_security", undefined, {}));
    expect(result.code).toBe("unauthorized");
    expect(result.reason).toBe("action_denied");
  });

  it("Analyst/Manager/Head hold run_reports but none holds the 'administration' feature - each is denied with scope_denied; only Super Admin succeeds", async () => {
    for (const role of ["analyst", "partnership_manager", "partnership_head"]) {
      const actor = await actorFor(role);
      const result = failure(await runReport(actor, "administration_security", undefined, {}));
      expect(result.code, role).toBe("unauthorized");
      expect(result.reason, role).toBe("scope_denied");
    }
    const superAdmin = await actorFor("super_admin");
    const result = must(await runReport(superAdmin, "administration_security", undefined, {}), "super_admin");
    expect(result.rowCount).toBeGreaterThan(0); // sees at least the five seeded test identities
  });
});

// ==================================================================================================
describe("Section 17: the Viewer-safe path blocks Finance/Administration families outright, regardless of role", () => {
  it("even Super Admin cannot reach finance_status or administration_security through viewer-run", async () => {
    const superAdmin = await actorFor("super_admin");
    for (const reportId of ["finance_status", "administration_security"] as const) {
      const result = failure(await runReport(superAdmin, reportId, undefined, { viewerSafe: true }));
      expect(result.code, reportId).toBe("unauthorized");
      expect(result.reason, reportId).toBe("action_denied");
    }
  });
});

// ==================================================================================================
describe("Record scope (section 8): a Partner outside the actor's own region grants never appears in Partner Portfolio", () => {
  it("Viewer's Partner Portfolio includes the Kerala fixture Partner but never the Delhi one", async () => {
    const viewer = await actorFor("viewer");
    const result = must(await runReport(viewer, "partner_portfolio", undefined, { viewerSafe: true }), "viewer partner_portfolio");
    const refs = result.rows.map((row) => row.partnerRef);
    expect(refs).toContain(fixtures.keralaPartnerRef);
    expect(refs).not.toContain(fixtures.delhiPartnerRef);
  });

  it("Super Admin's GLOBAL scope sees BOTH the Kerala and the Delhi fixture Partner", async () => {
    const superAdmin = await actorFor("super_admin");
    const result = must(await runReport(superAdmin, "partner_portfolio", undefined, {}), "super_admin partner_portfolio");
    const refs = result.rows.map((row) => row.partnerRef);
    expect(refs).toContain(fixtures.keralaPartnerRef);
    expect(refs).toContain(fixtures.delhiPartnerRef);
  });

  it("a partnerRef filter never widens scope - filtering to the out-of-scope Delhi Partner from Viewer's own actor never returns that Partner's data, whether Partners' own gate denies the lookup outright or the composed result is simply empty", async () => {
    const viewer = await actorFor("viewer");
    const outcome = await runReport(viewer, "channel_growth_freshness", { partnerRef: fixtures.delhiPartnerRef }, { viewerSafe: true });
    if (outcome.ok) {
      expect(outcome.data.rows.some((row) => row.partnerLabel && String(row.partnerLabel).includes("Delhi"))).toBe(false);
    } else {
      // Partners' own getPartner (composed, never re-implemented here) denies the out-of-scope ref
      // outright - still zero leaked data, just a different (equally safe) source-module convention.
      expect(outcome.code).toBe("unauthorized");
      expect(outcome.reason).toBe("scope_denied");
    }
  });
});

// ==================================================================================================
describe("Campaign Delivery - exercised against a real Campaign/Assignment/Content chain", () => {
  it("Manager sees the real fixture Assignment and Content rows, filtered to the fixture Campaign", async () => {
    const manager = await actorFor("partnership_manager");
    const result = must(await runReport(manager, "campaign_delivery", { campaignRef: fixtures.campaignRef }, {}), "manager campaign_delivery");
    expect(result.rows.some((row) => row.assignmentRef === fixtures.assignmentRef)).toBe(true);
    expect(result.rows.some((row) => row.contentRef === fixtures.contentRef)).toBe(true);
    expect(result.scopeSummary.note).toMatch(/Reports Fixture Campaign/);
  });
});

// ==================================================================================================
describe("Partner Review Evidence - exercised against a real FINALIZED review, Production/Compliance/Performance kept separate", () => {
  it("the finalized fixture review appears, and its three evidence sections are independently keyed (never a blended score)", async () => {
    const head = await actorFor("partnership_head");
    const result = must(await runReport(head, "partner_review_evidence", { partnerRef: fixtures.keralaPartnerRef }, {}), "head partner_review_evidence");
    expect(result.rows.some((row) => row.reviewRef === fixtures.finalizedReviewRef)).toBe(true);
    expect(Object.keys(result.sections).sort()).toEqual(["compliance", "performance", "production"].sort());
    expect(JSON.stringify(result)).not.toMatch(/blendedScore|compositeScore/i);
  });
});

// ==================================================================================================
describe("Campaign Performance - exercised end to end (no Analytics fixture data in this seed; wiring/contract certified)", () => {
  it("Manager can run it, platform metrics stay per-platform and the bounded contract holds", async () => {
    const manager = await actorFor("partnership_manager");
    const result = must(await runReport(manager, "campaign_performance", undefined, {}), "manager campaign_performance");
    expect(Object.keys(result.metrics).some((key) => key.includes("_instagram"))).toBe(true);
    expect(Object.keys(result.metrics).some((key) => key.includes("_youtube"))).toBe(true);
    expect(Object.keys(result.metrics).some((key) => /combined|allplatforms/i.test(key))).toBe(false);
  });
});

// ==================================================================================================
describe("Bounded execution (section 10/22): every result respects its own maxRows and carries a boolean truncated flag", () => {
  it("across every full-execution report Manager can reach, rowCount never exceeds maxRows", async () => {
    const manager = await actorFor("partnership_manager");
    for (const reportId of ["campaign_delivery", "campaign_performance", "channel_growth_freshness", "partner_review_evidence", "finance_status", "operations_attention", "discovery_funnel", "partner_portfolio"] as const) {
      const result = must(await runReport(manager, reportId, undefined, {}), reportId);
      expect(result.rowCount, reportId).toBeLessThanOrEqual(result.maxRows);
      expect(typeof result.truncated, reportId).toBe("boolean");
      expect(result.generatedAt, reportId).toBeTruthy();
      expect(result.evidenceCutoff, reportId).toBeTruthy();
    }
  });

  it("Monthly Partner Performance and Cross-Platform Partner/Programme (no required filters) also respect maxRows and the bounded contract", async () => {
    const manager = await actorFor("partnership_manager");
    for (const reportId of ["monthly_partner_performance", "cross_platform_partner_programme"] as const) {
      const result = must(await runReport(manager, reportId, undefined, {}), reportId);
      expect(result.rowCount, reportId).toBeLessThanOrEqual(result.maxRows);
      expect(typeof result.truncated, reportId).toBe("boolean");
    }
  });
});

// ==================================================================================================
describe("Step 19A.1: the four management-scale families have real governed execution - never a stub, never ok:false with code 'unsupported'", () => {
  it("Monthly Partner Performance runs for the fixture Kerala Partner/period with no blended score and Production/Compliance/Performance kept separate", async () => {
    const manager = await actorFor("partnership_manager");
    const result = must(await runReport(manager, "monthly_partner_performance", { partnerRef: fixtures.keralaPartnerRef, period: PERIOD }, {}), "monthly_partner_performance");
    expect(result.reportId).toBe("monthly_partner_performance");
    expect(Object.keys(result.sections).sort()).toEqual(["compliance", "dataQualityWarnings", "performance", "production", "topContent"].sort());
    expect(JSON.stringify(result)).not.toMatch(/blendedScore|compositeScore|overallScore/i);
    expect(result.rowCount).toBeLessThanOrEqual(result.maxRows);
  });

  it("Campaign / Event Performance runs against the real fixture Campaign/Assignment/Content chain, platform metrics stay per-platform", async () => {
    const manager = await actorFor("partnership_manager");
    const result = must(await runReport(manager, "campaign_event_performance", { campaignRef: fixtures.campaignRef }, {}), "campaign_event_performance");
    expect(result.rows.some((row) => row.assignmentRef === fixtures.assignmentRef)).toBe(true);
    expect(result.rows.some((row) => row.contentRef === fixtures.contentRef)).toBe(true);
    expect(Object.keys(result.metrics).some((key) => key.includes("_instagram"))).toBe(true);
    expect(Object.keys(result.metrics).some((key) => key.includes("_youtube"))).toBe(true);
    expect(Object.keys(result.metrics).some((key) => /combined|allplatforms/i.test(key))).toBe(false);
  });

  it("Cross-Platform Partner / Programme runs for one Partner, every platform metric stays side by side and bounded", async () => {
    const manager = await actorFor("partnership_manager");
    const result = must(await runReport(manager, "cross_platform_partner_programme", { partnerRef: fixtures.keralaPartnerRef }, {}), "cross_platform_partner_programme");
    expect(result.metrics.partnerCount).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.partnerRef).toBe(fixtures.keralaPartnerRef);
  });

  it("Long-Period Partner Programme requires both partnerRef and periods filters - invalid_input, never a fabricated empty success", async () => {
    const manager = await actorFor("partnership_manager");
    const missingPartner = failure(await runReport(manager, "long_period_partner_programme", { periods: PERIOD }, {}));
    expect(missingPartner.code).toBe("invalid_input");
    const missingPeriods = failure(await runReport(manager, "long_period_partner_programme", { partnerRef: fixtures.keralaPartnerRef }, {}));
    expect(missingPeriods.code).toBe("invalid_input");
  });

  it("Long-Period Partner Programme runs for the fixture Partner + its real finalized-review period, and the finalized Review is reflected", async () => {
    const manager = await actorFor("partnership_manager");
    const result = must(await runReport(manager, "long_period_partner_programme", { partnerRef: fixtures.keralaPartnerRef, periods: PERIOD }, {}), "long_period_partner_programme");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.periodKey).toBe(PERIOD);
    expect(result.metrics.finalizedReviewCount).toBe(1);
    expect(result.metrics.coveredPeriodCount).toBe(1);
    expect(result.metrics.droppedPeriodCount).toBe(0);
  });

  it("Long-Period Partner Programme bounds a request beyond 6 periods, disclosing the drop rather than silently including everything", async () => {
    const manager = await actorFor("partnership_manager");
    const sevenPeriods = ["2020-01", "2020-02", "2020-03", "2020-04", "2020-05", "2020-06", "2020-07"].join(",");
    const result = must(await runReport(manager, "long_period_partner_programme", { partnerRef: fixtures.keralaPartnerRef, periods: sevenPeriods }, {}), "long_period_partner_programme (bounded)");
    expect(result.metrics.requestedPeriodCount).toBe(7);
    expect(result.metrics.coveredPeriodCount).toBe(6);
    expect(result.metrics.droppedPeriodCount).toBe(1);
    expect(result.rows).toHaveLength(6);
    expect(result.truncated).toBe(true);
  });
});

// ==================================================================================================
describe("Finalized snapshot (section 15/21)", () => {
  it("finalize persists an immutable snapshot; the finalizing actor can read it back with the exact definition version and result pinned", async () => {
    const manager = await actorFor("partnership_manager");
    const finalized = must(await finalizeReport(manager, { reportId: "operations_attention" }), "finalize operations_attention");
    snapshotRefs.push(finalized.snapshotRef);
    expect(finalized.definitionVersion).toBe(1);
    expect(finalized.createdByUserRef).toBe(manager.userRef);

    const fetched = must(await getFinalizedSnapshot(manager, finalized.snapshotRef), "get own snapshot");
    expect(fetched.snapshotRef).toBe(finalized.snapshotRef);
    expect(fetched.result).toEqual(finalized.result);
  });

  it("a different actor cannot read someone else's finalized snapshot - neutral not_found, never a leaked existence", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const finalized = must(await finalizeReport(manager, { reportId: "discovery_funnel" }), "finalize discovery_funnel");
    snapshotRefs.push(finalized.snapshotRef);

    const result = failure(await getFinalizedSnapshot(head, finalized.snapshotRef));
    expect(result.code).toBe("not_found");
  });

  it("Step 19A.1: a management-scale family can now be finalized like any other real report - never a fabricated snapshot, never 'unsupported'", async () => {
    const manager = await actorFor("partnership_manager");
    const finalized = must(await finalizeReport(manager, { reportId: "cross_platform_partner_programme", filters: { partnerRef: fixtures.keralaPartnerRef } }), "finalize cross_platform_partner_programme");
    snapshotRefs.push(finalized.snapshotRef);
    expect(finalized.reportId).toBe("cross_platform_partner_programme");

    const fetched = must(await getFinalizedSnapshot(manager, finalized.snapshotRef), "get own snapshot");
    expect(fetched.result).toEqual(finalized.result);
  });
});
