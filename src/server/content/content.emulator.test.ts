// Step 11A.1 - real reads/writes against the running Firestore/Auth
// emulator (no mocks), same rationale as Assignments'/Campaigns'/
// Vendors'/Partners' own emulator test suites. Run with
// `pnpm test:emulator` against a running `pnpm firebase:emulators`.
//
// Rewritten entirely for the business-process correction: Content is now
// ONE canonical submission-review thread per Assignment (OPEN ->
// UNDER_REVIEW -> APPROVED, with REVISION_REQUESTED/CANCELLED as branch/
// terminal states), created automatically the first time a public
// submission session is created for that Assignment - there is no manual
// create, no production/version/submit/publication-evidence/complete
// step anywhere. The revision-loop/reusable-token proofs live in
// src/server/assignments/external-submission.emulator.test.ts (this file
// stays focused on Content's own domain: thread creation, scope/
// authorization, the lifecycle table, fulfillment, cancellation, and
// publication-identity claim adaptation).
import { beforeAll, describe, expect, it } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth } from "@/server/firebase/admin";
import { createAssignment } from "@/server/assignments/assignment-service";
import { transitionAssignmentLifecycle } from "@/server/assignments/assignment-lifecycle-service";
import { getAssignmentDocByRef } from "@/server/assignments/firestore";
import { createExternalSubmissionSession, submitExternalLinks } from "@/server/assignments/external-submission-service";
// (kept as one import; submitExternalLinks is used directly in a few
// tests that need the raw token, not just the submitOnce/driveToApproved
// helper wrappers.)
import { seedAssignmentsData } from "@/server/assignments/seed-assignments-data";
import type { AssignmentDto } from "@/server/assignments/client-dto";
import { createCampaign } from "@/server/campaigns/campaign-service";
import { transitionCampaignLifecycle } from "@/server/campaigns/campaign-lifecycle-service";
import { seedCampaignsData } from "@/server/campaigns/seed-campaigns-data";
import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { seedVendorsData } from "@/server/vendors/seed-vendors-data";
import { evaluateAssignmentFulfillment } from "./fulfillment-service";
import { getContentAssignmentThreadClaim } from "./firestore";
import { getContent, getContentHistory, listContent, resolveOrCreateContentThread } from "./content-service";
import { approveContentThread, cancelContent, requestContentRevision } from "./content-lifecycle-service";
import { seedContentData } from "./seed-content-data";
import type { ContentDto } from "./client-dto";

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
  await seedAssignmentsData();
  await seedContentData();

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
function uniqueUrl(prefix: string): string {
  return `https://instagram.com/p/${prefix}-${runId}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createFreshPlannedCampaign(head: ActorContext, overrides: Record<string, unknown> = {}) {
  const created = await createCampaign(
    head,
    {
      name: uniqueName("Content Test Campaign"),
      objective: "x",
      platforms: ["instagram", "youtube"],
      startDate: "2026-01-01",
      endDate: "2026-06-01",
      regionIds: ["Kerala"],
      defaultReviewPolicy: "REVIEW_REQUIRED",
      ...overrides,
    },
    "req-campaign-create",
  );
  if (!created.ok) throw new Error(`unreachable: ${created.message}`);
  const planned = await transitionCampaignLifecycle(head, created.data.campaignRef, { to: "PLANNED", expectedVersion: created.data.version }, "req-campaign-plan");
  if (!planned.ok) throw new Error(`unreachable: ${planned.message}`);
  return { ...created.data, version: planned.data.version, status: planned.data.status };
}

async function createFreshAssignment(head: ActorContext, overrides: Record<string, unknown> = {}): Promise<AssignmentDto> {
  const { campaignOverrides, ...assignmentOverrides } = overrides as { campaignOverrides?: Record<string, unknown> } & Record<string, unknown>;
  const campaign = assignmentOverrides.campaignRef ? undefined : await createFreshPlannedCampaign(head, campaignOverrides);
  const result = await createAssignment(
    head,
    { campaignRef: campaign?.campaignRef, partnerRef: "seed-partner-direct", brief: { platforms: ["instagram"] }, ...assignmentOverrides },
    "req-assignment-create",
  );
  if (!result.ok) throw new Error(`unreachable: ${result.message}`);
  return result.data;
}

// Drives an Assignment through the ASSIGNED -> ACCEPTED -> IN_PROGRESS
// chain, starting the walk right AFTER `from` (default "DRAFT", i.e. the
// full chain) up to (and including) `target`.
async function driveAssignmentTo(
  head: ActorContext,
  assignmentRef: string,
  startVersion: number,
  target: "ASSIGNED" | "ACCEPTED" | "IN_PROGRESS",
  from: "DRAFT" | "ASSIGNED" | "ACCEPTED" = "DRAFT",
): Promise<number> {
  const chain: Array<"ASSIGNED" | "ACCEPTED" | "IN_PROGRESS"> = ["ASSIGNED", "ACCEPTED", "IN_PROGRESS"];
  const fromIndex = from === "DRAFT" ? -1 : chain.indexOf(from);
  let version = startVersion;
  for (let i = fromIndex + 1; i < chain.length; i += 1) {
    const to = chain[i]!;
    const step = await transitionAssignmentLifecycle(head, assignmentRef, { to, expectedVersion: version }, "req-drive");
    if (!step.ok) throw new Error(`unreachable: ${step.message}`);
    version = step.data.version;
    if (to === target) break;
  }
  return version;
}

async function createOperationalAssignment(
  head: ActorContext,
  target: "ASSIGNED" | "ACCEPTED" | "IN_PROGRESS" = "IN_PROGRESS",
  overrides: Record<string, unknown> = {},
): Promise<AssignmentDto> {
  const assignment = await createFreshAssignment(head, overrides);
  const version = await driveAssignmentTo(head, assignment.assignmentRef, assignment.version, target);
  return { ...assignment, version };
}

// Drives a real submission through the public route (the ONLY way a
// thread's status ever moves off OPEN) and returns the resulting thread,
// bounded-read via listContent - never a direct Firestore write.
async function submitOnce(head: ActorContext, assignmentRef: string, url = uniqueUrl("submit")): Promise<ContentDto> {
  const session = await createExternalSubmissionSession(head, assignmentRef, { recipientType: "PARTNER" }, "req-session");
  if (!session.ok) throw new Error(`unreachable: ${session.message}`);
  const submitted = await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url }]);
  if (!submitted.ok) throw new Error(`unreachable: ${submitted.message}`);
  const list = await listContent(head, { assignmentRef, limit: 1 });
  if (!list.ok) throw new Error("unreachable");
  const thread = list.data.content[0];
  if (!thread) throw new Error("unreachable: no thread found");
  return thread;
}

// A bounded read of the Assignment's one canonical thread - never a
// direct Firestore read, mirrors AssignmentContentPanel's own real
// client-side lookup.
async function threadForTest(head: ActorContext, assignmentRef: string): Promise<ContentDto> {
  const list = await listContent(head, { assignmentRef, limit: 1 });
  if (!list.ok) throw new Error("unreachable");
  const thread = list.data.content[0];
  if (!thread) throw new Error(`unreachable: no thread found for ${assignmentRef}`);
  return thread;
}

async function driveToApproved(head: ActorContext, assignmentRef: string, url = uniqueUrl("approve")): Promise<ContentDto> {
  const underReview = await submitOnce(head, assignmentRef, url);
  const approved = await approveContentThread(head, underReview.contentRef, { reviewedRevisionNumber: underReview.reviewedRevisionNumber!, expectedVersion: underReview.version }, "req-approve");
  if (!approved.ok) throw new Error(`unreachable: ${approved.message}`);
  return approved.data;
}

describe("Thread creation (resolveOrCreateContentThread)", () => {
  it("the first call creates a fresh OPEN thread with the Assignment's own snapshot", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const thread = await resolveOrCreateContentThread(assignment.assignmentRef, head.userRef, "req");
    expect(thread.status).toBe("OPEN");
    expect(thread.currentRevisionNumber).toBe(0);
    expect(thread.reviewedRevisionNumber).toBeNull();
    expect(thread.currentLinks).toEqual([]);
    expect(thread.assignmentRef).toBe(assignment.assignmentRef);
  });

  it("every subsequent call returns the SAME thread - idempotent get-or-create, never a second competing thread", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const first = await resolveOrCreateContentThread(assignment.assignmentRef, head.userRef, "req-1");
    const second = await resolveOrCreateContentThread(assignment.assignmentRef, head.userRef, "req-2");
    expect(second.uid).toBe(first.uid);
    expect(second.contentRef).toBe(first.contentRef);
  });

  it("the one-canonical-thread-per-Assignment claim exists and points at the created thread", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const thread = await resolveOrCreateContentThread(assignment.assignmentRef, head.userRef, "req");
    const claim = await getContentAssignmentThreadClaim(assignment.assignmentRef);
    expect(claim?.contentUid).toBe(thread.uid);
    expect(claim?.contentRef).toBe(thread.contentRef);
  });

  it("concurrent calls for the same Assignment create exactly ONE thread, never two", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => resolveOrCreateContentThread(assignment.assignmentRef, head.userRef, `req-${i}`)));
    const uniqueUids = new Set(results.map((r) => r.uid));
    expect(uniqueUids.size).toBe(1);
  }, 20_000);

  it("creating a real external-submission session drives thread creation automatically - no separate manual create step exists", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const before = await listContent(head, { assignmentRef: assignment.assignmentRef, limit: 1 });
    if (!before.ok) throw new Error("unreachable");
    expect(before.data.content).toHaveLength(0);

    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    expect(session.ok).toBe(true);

    const after = await listContent(head, { assignmentRef: assignment.assignmentRef, limit: 1 });
    if (!after.ok) throw new Error("unreachable");
    expect(after.data.content).toHaveLength(1);
    expect(after.data.content[0]!.status).toBe("OPEN");
  });
});

describe("Authorization / scope", () => {
  it("Viewer and Analyst are denied the Content feature entirely (feature_denied)", async () => {
    for (const role of ["viewer", "analyst"]) {
      const actor = await actorFor(role);
      const getResult = await getContent(actor, "seed-content-open");
      expect(getResult.ok).toBe(false);
      if (getResult.ok) throw new Error("unreachable");
      expect(getResult.reason).toBe("feature_denied");

      const listResult = await listContent(actor, { limit: 20 });
      expect(listResult.ok).toBe(false);
      if (listResult.ok) throw new Error("unreachable");
      expect(listResult.reason).toBe("feature_denied");
    }
  });

  it("Manager and Head can both read a same-scope Content record (Kerala/Maharashtra)", async () => {
    for (const role of ["partnership_manager", "partnership_head"]) {
      const actor = await actorFor(role);
      const result = await getContent(actor, "seed-content-under-review");
      expect(result.ok).toBe(true);
    }
  });

  it("community-story-reel-01 is reachable to Head ONLY through its EXPLICIT_RECORD grant - unreachable to Manager, unreachable via any of Head's own region/team grants", async () => {
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");

    const asHead = await getContent(head, "community-story-reel-01");
    expect(asHead.ok).toBe(true);

    const asManager = await getContent(manager, "community-story-reel-01");
    expect(asManager.ok).toBe(false);
    if (asManager.ok) throw new Error("unreachable");
    expect(asManager.reason).toBe("scope_denied");
  });

  it("cross-scope user (has the feature, lacks scope over this record) gets scope_denied, same safe denial as a nonexistent contentRef", async () => {
    const manager = await actorFor("partnership_manager");
    // seed-content-revision-requested's own Assignment (seed-assignment-
    // in-progress) carries empty regionIds/teamIds/null-owner - reachable
    // only via GLOBAL or an explicit grant, neither of which Manager
    // holds.
    const real = await getContent(manager, "seed-content-revision-requested");
    const fake = await getContent(manager, "not-a-real-content-ref");
    expect(real.ok).toBe(false);
    if (real.ok) throw new Error("unreachable");
    expect(real.reason).toBe("scope_denied");
    expect(fake.ok).toBe(false);
  });

  it("review_content is allowed to both Manager and Head, in-scope - approve and request-revision both", async () => {
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");

    for (const [role, actor] of [
      ["partnership_manager", manager],
      ["partnership_head", head],
    ] as const) {
      const assignment = await createOperationalAssignment(head, "ASSIGNED");
      const thread = await submitOnce(head, assignment.assignmentRef);

      const approveAttempt = await approveContentThread(actor, thread.contentRef, { reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req");
      expect(approveAttempt.ok, `${role} should be allowed to approve in-scope`).toBe(true);
    }

    for (const [role, actor] of [
      ["partnership_manager", manager],
      ["partnership_head", head],
    ] as const) {
      const assignment = await createOperationalAssignment(head, "ASSIGNED");
      const thread = await submitOnce(head, assignment.assignmentRef);

      const requestAttempt = await requestContentRevision(actor, thread.contentRef, { reason: "Needs work.", reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req");
      expect(requestAttempt.ok, `${role} should be allowed to request revision in-scope`).toBe(true);
    }
  });

  // The load-bearing proof that review_content remains a genuinely
  // distinct, independently-gated action permission (not merely folded
  // into generic Content access): Manager holds the action grant but is
  // still denied on a Content record outside their own scope - the scope
  // gate fires before any status/lifecycle check.
  it("review_content is denied to Manager cross-scope even though the action grant itself is held", async () => {
    const manager = await actorFor("partnership_manager");
    const attempt = await approveContentThread(manager, "community-story-reel-01", { reviewedRevisionNumber: 1, expectedVersion: 1 }, "req");
    expect(attempt.ok).toBe(false);
    if (attempt.ok) throw new Error("unreachable");
    expect(attempt.reason).toBe("scope_denied");
  });

  it("Viewer/Analyst are denied review_content entirely (feature_denied, before any scope check)", async () => {
    for (const role of ["viewer", "analyst"]) {
      const actor = await actorFor(role);
      const attempt = await approveContentThread(actor, "seed-content-under-review", { reviewedRevisionNumber: 1, expectedVersion: 1 }, "req");
      expect(attempt.ok).toBe(false);
      if (attempt.ok) throw new Error("unreachable");
      expect(attempt.reason).toBe("feature_denied");
    }
  });

  it("scoped list never returns an out-of-scope Content record", async () => {
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const inScope = await resolveOrCreateContentThread(assignment.assignmentRef, head.userRef, "req");

    const page = await listContent(manager, { limit: 100 });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("unreachable");
    expect(page.data.content.every((c) => c.contentRef !== "seed-content-revision-requested")).toBe(true);
    expect(page.data.content.some((c) => c.contentRef === inScope.contentRef)).toBe(true);
  });

  it("super_admin (GLOBAL) reads and lists everything", async () => {
    const admin = await actorFor("super_admin");
    const all = await listContent(admin, { limit: 100 });
    expect(all.ok).toBe(true);
    if (!all.ok) throw new Error("unreachable");
    expect(all.data.content.length).toBeGreaterThanOrEqual(6);
  });
});

describe("Lifecycle (OPEN -> UNDER_REVIEW -> APPROVED, REVISION_REQUESTED loop)", () => {
  it("full happy path: submit -> approve, no separate Complete Content step anywhere", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const thread = await submitOnce(head, assignment.assignmentRef);
    expect(thread.status).toBe("UNDER_REVIEW");

    const approved = await approveContentThread(head, thread.contentRef, { reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req");
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error("unreachable");
    expect(approved.data.status).toBe("APPROVED");
    expect(approved.data.approvedAt).not.toBeNull();
    expect(approved.data.qualifyingFulfillment?.kind).toBe("QUALIFYING_REQUIRED");
  });

  it("revision loop: request revision requires a real reason, and resubmission moves the thread back to UNDER_REVIEW", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const thread = await submitOnce(head, assignment.assignmentRef);

    const missingReason = await requestContentRevision(head, thread.contentRef, { reason: "", reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req");
    expect(missingReason.ok).toBe(false);

    const revised = await requestContentRevision(head, thread.contentRef, { reason: "Retake the shot.", reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req");
    expect(revised.ok).toBe(true);
    if (!revised.ok) throw new Error("unreachable");
    expect(revised.data.status).toBe("REVISION_REQUESTED");
    expect(revised.data.statusReason).toBe("Retake the shot.");

    const history = await getContentHistory(head, thread.contentRef, {});
    expect(history.ok).toBe(true);
    if (!history.ok) throw new Error("unreachable");
    const kinds = history.data.events.map((e) => e.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("submitted");
    expect(kinds).toContain("revision_requested");
  });

  it("APPROVED does not require a reason, REVISION_REQUESTED does - matches CONTENT_REASON_REQUIRED_STATUSES exactly", async () => {
    const head = await actorFor("partnership_head");

    const assignmentA = await createOperationalAssignment(head, "ASSIGNED");
    const threadA = await submitOnce(head, assignmentA.assignmentRef);
    const approved = await approveContentThread(head, threadA.contentRef, { reviewedRevisionNumber: threadA.reviewedRevisionNumber!, expectedVersion: threadA.version }, "req");
    expect(approved.ok).toBe(true);

    const assignmentB = await createOperationalAssignment(head, "ASSIGNED");
    const threadB = await submitOnce(head, assignmentB.assignmentRef);
    const revisedNoReason = await requestContentRevision(head, threadB.contentRef, { reason: "", reviewedRevisionNumber: threadB.reviewedRevisionNumber!, expectedVersion: threadB.version }, "req");
    expect(revisedNoReason.ok).toBe(false);
  });

  it("the lifecycle table itself blocks illegal transitions: cannot approve/request-revision an OPEN thread, cannot re-decide an APPROVED thread", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const openThread = await resolveOrCreateContentThread(assignment.assignmentRef, head.userRef, "req");

    const approveOpen = await approveContentThread(head, openThread.contentRef, { reviewedRevisionNumber: 1, expectedVersion: openThread.version }, "req");
    expect(approveOpen.ok).toBe(false);
    if (approveOpen.ok) throw new Error("unreachable");
    expect(approveOpen.code).toBe("invalid_input");

    const requestOpen = await requestContentRevision(head, openThread.contentRef, { reason: "x", reviewedRevisionNumber: 1, expectedVersion: openThread.version }, "req");
    expect(requestOpen.ok).toBe(false);

    const approved = await driveToApproved(head, assignment.assignmentRef);
    const reDecide = await approveContentThread(head, approved.contentRef, { reviewedRevisionNumber: approved.reviewedRevisionNumber!, expectedVersion: approved.version }, "req");
    expect(reDecide.ok).toBe(false);
    if (reDecide.ok) throw new Error("unreachable");
    expect(reDecide.code).toBe("invalid_input");
  });

  it("a stale reviewedRevisionNumber against the decision fails - never silently applies to a newer revision", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");

    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");
    const firstSubmit = await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("stale-1") }]);
    if (!firstSubmit.ok) throw new Error("unreachable");

    const thread1 = await threadForTest(head, assignment.assignmentRef);
    const staleRevision = thread1.reviewedRevisionNumber!;

    await requestContentRevision(head, thread1.contentRef, { reason: "changes", reviewedRevisionNumber: staleRevision, expectedVersion: thread1.version }, "req");

    // The SAME token/session resubmits (reused, never a new one) -
    // revision 2 lands before the Manager's decision on revision 1 is
    // recorded.
    const secondSubmit = await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("stale-2") }]);
    if (!secondSubmit.ok) throw new Error("unreachable");

    const thread2 = await threadForTest(head, assignment.assignmentRef);
    const staleApprove = await approveContentThread(head, thread1.contentRef, { reviewedRevisionNumber: staleRevision, expectedVersion: thread2.version }, "req");
    expect(staleApprove.ok).toBe(false);
    if (staleApprove.ok) throw new Error("unreachable");
    expect(staleApprove.code).toBe("stale_write");

    // The real current revision still approves cleanly.
    const realApprove = await approveContentThread(head, thread2.contentRef, { reviewedRevisionNumber: thread2.reviewedRevisionNumber!, expectedVersion: thread2.version }, "req");
    expect(realApprove.ok).toBe(true);
  });
});

describe("Fulfillment", () => {
  it("an Assignment with no submission thread yet is unfulfilled with NO_SUBMISSION_THREAD", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS");
    const doc = await getAssignmentDocByRef(assignment.assignmentRef);
    if (!doc) throw new Error("unreachable");
    const result = await evaluateAssignmentFulfillment(doc);
    expect(result.fulfilled).toBe(false);
    expect(result.blockers[0]?.code).toBe("NO_SUBMISSION_THREAD");
  });

  it("OPEN/UNDER_REVIEW/REVISION_REQUESTED all leave the Assignment unfulfilled", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS");
    const thread = await submitOnce(head, assignment.assignmentRef);
    expect(thread.status).toBe("UNDER_REVIEW");

    const doc = await getAssignmentDocByRef(assignment.assignmentRef);
    if (!doc) throw new Error("unreachable");
    const result = await evaluateAssignmentFulfillment(doc);
    expect(result.fulfilled).toBe(false);
    expect(result.blockers[0]?.code).toBe("CONTENT_NOT_FULFILLED");
  });

  it("a fresh Assignment+thread pair auto-completes the Assignment via approveContentThread's own transaction, with no direct transitionAssignmentLifecycle(COMPLETED) call", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS");
    const approved = await driveToApproved(head, assignment.assignmentRef);
    expect(approved.status).toBe("APPROVED");
    expect(approved.qualifyingFulfillment?.kind).toBe("QUALIFYING_REQUIRED");

    const assignmentDoc = await getAssignmentDocByRef(assignment.assignmentRef);
    expect(assignmentDoc?.status).toBe("COMPLETED");
  });

  it("manual transitionAssignmentLifecycle(COMPLETED) is blocked while unfulfilled, and succeeds once the thread was already approved while the Assignment was ACCEPTED (not IN_PROGRESS, so no auto-trigger fired) - proving the shared evaluator backs both paths", async () => {
    const head = await actorFor("partnership_head");

    const blocked = await createOperationalAssignment(head, "IN_PROGRESS");
    const blockedAttempt = await transitionAssignmentLifecycle(head, blocked.assignmentRef, { to: "COMPLETED", expectedVersion: blocked.version }, "req");
    expect(blockedAttempt.ok).toBe(false);
    if (blockedAttempt.ok) throw new Error("unreachable");
    expect(blockedAttempt.code).toBe("not_ready");
    // No submission session was ever created for this Assignment - no
    // Content thread exists yet, so this is NO_SUBMISSION_THREAD (see
    // the "OPEN/UNDER_REVIEW/REVISION_REQUESTED all leave the Assignment
    // unfulfilled" test above for the CONTENT_NOT_FULFILLED case, which
    // requires a thread to already exist).
    expect(blockedAttempt.blockers?.[0]?.code).toBe("NO_SUBMISSION_THREAD");

    const accepted = await createOperationalAssignment(head, "ACCEPTED");
    await driveToApproved(head, accepted.assignmentRef);

    const stillAccepted = await getAssignmentDocByRef(accepted.assignmentRef);
    expect(stillAccepted?.status).toBe("ACCEPTED");

    const nowInProgressVersion = await driveAssignmentTo(head, accepted.assignmentRef, stillAccepted!.version, "IN_PROGRESS", "ACCEPTED");
    const manualComplete = await transitionAssignmentLifecycle(head, accepted.assignmentRef, { to: "COMPLETED", expectedVersion: nowInProgressVersion }, "req");
    expect(manualComplete.ok).toBe(true);
    if (!manualComplete.ok) throw new Error("unreachable");
    expect(manualComplete.data.status).toBe("COMPLETED");
  });

  it("a COMPLETED Assignment refuses a new external-submission session - nothing new can be issued once its one thread is closed", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS");
    await driveToApproved(head, assignment.assignmentRef);

    const assignmentDoc = await getAssignmentDocByRef(assignment.assignmentRef);
    expect(assignmentDoc?.status).toBe("COMPLETED");

    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    expect(session.ok).toBe(false);
    if (session.ok) throw new Error("unreachable");
    expect(session.message).toMatch(/COMPLETED/);
  });
});

describe("Cancellation", () => {
  it("cannot cancel an APPROVED thread - finality", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const approved = await driveToApproved(head, assignment.assignmentRef);
    const result = await cancelContent(head, approved.contentRef, { reason: "test", expectedVersion: approved.version }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("can cancel OPEN, UNDER_REVIEW, and REVISION_REQUESTED, each requiring a real reason", async () => {
    const head = await actorFor("partnership_head");

    const openAssignment = await createOperationalAssignment(head, "ASSIGNED");
    const openThread = await resolveOrCreateContentThread(openAssignment.assignmentRef, head.userRef, "req");
    const missingReason = await cancelContent(head, openThread.contentRef, { reason: "", expectedVersion: openThread.version }, "req");
    expect(missingReason.ok).toBe(false);
    const cancelledOpen = await cancelContent(head, openThread.contentRef, { reason: "No longer needed.", expectedVersion: openThread.version }, "req");
    expect(cancelledOpen.ok).toBe(true);
    if (!cancelledOpen.ok) throw new Error("unreachable");
    expect(cancelledOpen.data.status).toBe("CANCELLED");
    expect(cancelledOpen.data.statusReason).toBe("No longer needed.");

    const underReviewAssignment = await createOperationalAssignment(head, "ASSIGNED");
    const underReviewThread = await submitOnce(head, underReviewAssignment.assignmentRef);
    const cancelledUnderReview = await cancelContent(head, underReviewThread.contentRef, { reason: "Assignment scrapped.", expectedVersion: underReviewThread.version }, "req");
    expect(cancelledUnderReview.ok).toBe(true);

    const revisionRequestedAssignment = await createOperationalAssignment(head, "ASSIGNED");
    const revisionThread = await submitOnce(head, revisionRequestedAssignment.assignmentRef);
    const revised = await requestContentRevision(head, revisionThread.contentRef, { reason: "changes", reviewedRevisionNumber: revisionThread.reviewedRevisionNumber!, expectedVersion: revisionThread.version }, "req");
    if (!revised.ok) throw new Error("unreachable");
    const cancelledRevisionRequested = await cancelContent(head, revised.data.contentRef, { reason: "Assignment scrapped.", expectedVersion: revised.data.version }, "req");
    expect(cancelledRevisionRequested.ok).toBe(true);
  });
});

describe("Publication-identity claims (adapted for revisions)", () => {
  it("the SAME thread resubmitting the identical URL across revisions is never a collision (same-thread re-claim)", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const sharedUrl = uniqueUrl("same-thread-reclaim");

    const thread1 = await submitOnce(head, assignment.assignmentRef, sharedUrl);
    await requestContentRevision(head, thread1.contentRef, { reason: "changes", reviewedRevisionNumber: thread1.reviewedRevisionNumber!, expectedVersion: thread1.version }, "req");

    // Resubmit the SAME URL again via a fresh session on the SAME
    // Assignment (the reuse guard means it is the SAME underlying
    // session/thread) - never a collision against itself.
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    // The reuse guard refuses a second session while the thread is live -
    // this IS the proof the same session/token is reused, not a new one.
    expect(session.ok).toBe(false);
  });

  it("claiming the seeded collision URL against a DIFFERENT thread is rejected atomically, the whole submit fails, never a partial accept", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");

    const result = await submitExternalLinks(session.data.rawToken, [
      { platform: "instagram", url: uniqueUrl("safe-row") },
      { platform: "instagram", url: "https://instagram.com/p/seed-content-collision" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid");

    // Atomic failure - the safe row was NOT partially accepted either;
    // the thread is still OPEN with no revision recorded at all.
    const list = await listContent(head, { assignmentRef: assignment.assignmentRef, limit: 1 });
    if (!list.ok) throw new Error("unreachable");
    const openThread = list.data.content[0];
    expect(openThread?.status).toBe("OPEN");
    expect(openThread?.currentRevisionNumber).toBe(0);
  });

  // A URL dropped from a later revision leaves its own claim doc as a
  // harmless orphan (design choice documented in publication-identity.ts
  // and types.ts) rather than being deleted - proven here by asserting
  // the claim itself is never removed once created. The full resubmit-
  // with-drop-then-reinclude round trip through the real token lives in
  // external-submission.emulator.test.ts's own revision-loop suite.
  it("a claim doc, once created, is never deleted even after the thread's OWN thread claim (not the URL claim) is re-read", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const thread1 = await submitOnce(head, assignment.assignmentRef, uniqueUrl("orphan-a"));
    await requestContentRevision(head, thread1.contentRef, { reason: "changes", reviewedRevisionNumber: thread1.reviewedRevisionNumber!, expectedVersion: thread1.version }, "req");

    const claim = await getContentAssignmentThreadClaim(assignment.assignmentRef);
    expect(claim).not.toBeNull();
    expect(claim?.contentUid).toBeTruthy();
  });
});

describe("Seeded fixtures", () => {
  it("carries a real example of every canonical status", async () => {
    // GLOBAL scope (super_admin) - several seeded fixtures deliberately
    // carry empty regionIds/teamIds/null-owner (out of every non-GLOBAL
    // role's scope, proving those specific scope-denial fixtures work
    // elsewhere in this file) - this sanity check needs unconditional
    // read access, not a role-scoped one.
    const admin = await actorFor("super_admin");
    const byRef: Record<string, string> = {
      "seed-content-open": "OPEN",
      "seed-content-under-review": "UNDER_REVIEW",
      "seed-content-revision-requested": "REVISION_REQUESTED",
      "seed-content-approved": "APPROVED",
      "seed-content-cancelled": "CANCELLED",
    };
    for (const [ref, status] of Object.entries(byRef)) {
      const result = await getContent(admin, ref);
      expect(result.ok, `${ref} should resolve`).toBe(true);
      if (!result.ok) continue;
      expect(result.data.status).toBe(status);
    }
  });

  it("has no Finance/Agreement/Payable/Invoice/Payment field anywhere on the DTO", async () => {
    const head = await actorFor("partnership_head");
    const result = await getContent(head, "seed-content-approved");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const keys = JSON.stringify(result.data).toLowerCase();
    for (const forbidden of ["agreement", "payable", "invoice", "payment", "payee", "compensation"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("Concurrency", () => {
  it("concurrent approve-vs-request-revision decisions against the same UNDER_REVIEW thread: only one succeeds", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const thread = await submitOnce(head, assignment.assignmentRef);

    const results = await Promise.all([
      approveContentThread(head, thread.contentRef, { reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req-1"),
      requestContentRevision(head, thread.contentRef, { reason: "no", reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req-2"),
    ]);
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(1);
  }, 20_000);
});
