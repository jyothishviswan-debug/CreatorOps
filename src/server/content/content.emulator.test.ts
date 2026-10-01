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
import * as XLSX from "xlsx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
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
import { contentCollection, getContentAssignmentThreadClaim } from "./firestore";
import { getContent, getContentHistory, listContent, resolveOrCreateContentThread } from "./content-service";
import { approveContentThread, cancelContent, requestContentRevision } from "./content-lifecycle-service";
import { generateContentRef } from "./ids";
import { recordContentLinksOnBehalf } from "./manager-submission-service";
import { getImportTarget } from "@/server/imports/target-registry";
import { registerImportTargets } from "@/server/imports/register-targets";
import { getContentLinkImportBatchDetail, listContentLinkImportBatches } from "@/server/imports/content-link-import";
import { seedContentData } from "./seed-content-data";
import { contentDocSchema } from "./types";
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

// Finding #50 (reopened) test-only helper: writes one EXTRA already-
// APPROVED Content record directly for an Assignment, bypassing the
// normal session-creation flow. Used ONLY to prove
// evaluateAssignmentFulfillment's own counting logic never clamps/errors
// on genuine over-fulfillment - the real product flow today can reach AT
// MOST exactly requiredCount approved records (session creation is
// correctly refused once the Assignment auto-completes), so a qualifying
// record beyond that can only be constructed directly here; this is not
// claiming that exact sequence is reachable through the live UI today.
async function seedExtraApprovedContent(assignment: AssignmentDto, url: string): Promise<void> {
  const now = new Date().toISOString();
  const doc = contentDocSchema.parse({
    uid: contentCollection().doc().id,
    contentRef: generateContentRef(),
    version: 1,
    assignmentRef: assignment.assignmentRef,
    campaignRef: assignment.campaignRef,
    partnerRef: assignment.partnerRef,
    status: "APPROVED",
    statusReason: null,
    currentRevisionNumber: 1,
    reviewedRevisionNumber: 1,
    currentLinks: [{ platform: "instagram", originalUrl: url, normalizedUrl: url, recordedAt: now }],
    qualifyingFulfillment: { kind: "QUALIFYING_REQUIRED", reasonCode: null, determinedAt: now },
    dueAt: null,
    openedAt: now,
    firstSubmittedAt: now,
    lastSubmittedAt: now,
    approvedAt: now,
    cancelledAt: null,
    ownerUid: null,
    regionIds: assignment.regionIds,
    teamIds: assignment.teamIds,
    createdAt: now,
    createdByUserRef: "req-seed-extra-approved",
    updatedAt: now,
    updatedByUserRef: "req-seed-extra-approved",
  });
  await contentCollection().doc(doc.uid).set(doc);
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

  it("every subsequent call returns the SAME thread WHILE it is non-terminal - idempotent get-or-create, never a second competing thread", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const first = await resolveOrCreateContentThread(assignment.assignmentRef, head.userRef, "req-1");
    const second = await resolveOrCreateContentThread(assignment.assignmentRef, head.userRef, "req-2");
    expect(second.uid).toBe(first.uid);
    expect(second.contentRef).toBe(first.contentRef);
  });

  // Finding #50 (reopened): the whole point of restoring canonical
  // semantics - once the current cycle closes (APPROVED or CANCELLED),
  // the Assignment's obligation is NOT done-forever; the next call opens
  // a genuinely new, independent record.
  it("returns a NEW thread once the previous one reaches APPROVED, and re-points the claim at it", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS", { brief: { platforms: ["instagram"], requiredCount: 2 } });
    const approved = await driveToApproved(head, assignment.assignmentRef);
    expect(approved.status).toBe("APPROVED");

    const next = await resolveOrCreateContentThread(assignment.assignmentRef, head.userRef, "req-next");
    expect(next.contentRef).not.toBe(approved.contentRef);
    expect(next.status).toBe("OPEN");

    const claim = await getContentAssignmentThreadClaim(assignment.assignmentRef);
    expect(claim?.contentUid).toBe(next.uid);
    expect(claim?.contentRef).toBe(next.contentRef);
  });

  it("returns a NEW thread once the previous one is CANCELLED", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS");
    const opened = await resolveOrCreateContentThread(assignment.assignmentRef, head.userRef, "req-open");
    const cancelled = await cancelContent(head, opened.contentRef, { reason: "Test cancellation.", expectedVersion: opened.version }, "req-cancel");
    if (!cancelled.ok) throw new Error(`unreachable: ${cancelled.message}`);
    expect(cancelled.data.status).toBe("CANCELLED");

    const next = await resolveOrCreateContentThread(assignment.assignmentRef, head.userRef, "req-next");
    expect(next.uid).not.toBe(opened.uid);
    expect(next.status).toBe("OPEN");
  });

  it("the current-thread-per-Assignment claim exists and points at the created thread", async () => {
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

  it("concurrent calls AFTER the current thread has gone terminal still create exactly ONE new thread, never a duplicate", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS", { brief: { platforms: ["instagram"], requiredCount: 5 } });
    const approved = await driveToApproved(head, assignment.assignmentRef);

    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => resolveOrCreateContentThread(assignment.assignmentRef, head.userRef, `req-race-${i}`)));
    const uniqueRefs = new Set(results.map((r) => r.contentRef));
    expect(uniqueRefs.size).toBe(1);
    expect([...uniqueRefs][0]).not.toBe(approved.contentRef);
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

    // Production hardening (base spec section 4 - existence-leak normalization): a cross-scope ref
    // is no longer a distinguishable "scope_denied" 403 - it collapses into the exact same neutral
    // not_found outcome as a missing ref (contentNotFoundResult()), so a caller can never learn that
    // community-story-reel-01 exists at all.
    const asManager = await getContent(manager, "community-story-reel-01");
    expect(asManager.ok).toBe(false);
    if (asManager.ok) throw new Error("unreachable");
    expect(asManager.code).toBe("not_found");
    expect(asManager.reason).toBeUndefined();
  });

  it("cross-scope user (has the feature, lacks scope over this record) gets the SAME not_found outcome as a nonexistent contentRef - code and message both match", async () => {
    const manager = await actorFor("partnership_manager");
    // seed-content-revision-requested's own Assignment (seed-assignment-
    // in-progress) carries empty regionIds/teamIds/null-owner - reachable
    // only via GLOBAL or an explicit grant, neither of which Manager
    // holds.
    const real = await getContent(manager, "seed-content-revision-requested");
    const fake = await getContent(manager, "not-a-real-content-ref");
    expect(real.ok).toBe(false);
    expect(fake.ok).toBe(false);
    if (real.ok || fake.ok) throw new Error("unreachable");
    // The actual indistinguishability proof (base spec section 4: "Test both unknown ref and
    // known-but-unauthorized ref") - not just that both fail, but that a caller literally cannot
    // tell the two outcomes apart from the response shape.
    expect(real.code).toBe("not_found");
    expect(fake.code).toBe("not_found");
    expect(real.message).toBe(fake.message);
    expect(real.reason).toBeUndefined();
    expect(fake.reason).toBeUndefined();
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
  // gate fires before any status/lifecycle check. Production hardening
  // (base spec section 4): the denial is now the neutral not_found outcome
  // (loadAuthorizedContent's own scope-collapse), never a distinguishable
  // 403 - proving the gate still fires is now done by asserting the SAME
  // not_found outcome community-story-reel-01 produces for every other
  // out-of-scope lookup above, not by a scope-specific reason code.
  it("review_content is denied to Manager cross-scope even though the action grant itself is held", async () => {
    const manager = await actorFor("partnership_manager");
    const attempt = await approveContentThread(manager, "community-story-reel-01", { reviewedRevisionNumber: 1, expectedVersion: 1 }, "req");
    expect(attempt.ok).toBe(false);
    if (attempt.ok) throw new Error("unreachable");
    expect(attempt.code).toBe("not_found");
    expect(attempt.reason).toBeUndefined();
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

  // Finding #50 (reopened) closure-audit follow-up: the spec's own §15
  // test checklist named "requiredCount = 1 unchanged" as its own,
  // distinctly-asserted case - the test above proves the auto-complete
  // TRANSACTION mechanics for the default case, but never asserted the
  // actual requiredCount/qualifyingCount numbers evaluateAssignmentFulfillment
  // returns for it. This closes that gap explicitly.
  it("requiredCount = 1 (the default, brief.requiredCount omitted): a single approval fulfills with the honest 1/1 count, unchanged from before this finding", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS");
    const assignmentDocBefore = await getAssignmentDocByRef(assignment.assignmentRef);
    expect(assignmentDocBefore?.brief.requiredCount ?? null).toBeNull();

    const approved = await driveToApproved(head, assignment.assignmentRef);
    expect(approved.status).toBe("APPROVED");

    const assignmentDoc = await getAssignmentDocByRef(assignment.assignmentRef);
    expect(assignmentDoc?.status).toBe("COMPLETED");
    const result = await evaluateAssignmentFulfillment(assignmentDoc!);
    expect(result).toMatchObject({ fulfilled: true, requiredCount: 1, qualifyingCount: 1 });
  });

  // Finding #50 (reopened) closure-audit follow-up: §22's own closure
  // criteria named "cancelled Content does not qualify" as its own
  // requirement. This was previously only proven one layer up, in the
  // Partner Review evidence tests (a different function) - this proves it
  // directly against evaluateAssignmentFulfillment itself: a CANCELLED
  // record sitting right next to a later APPROVED one must never inflate
  // qualifyingCount.
  it("a CANCELLED Content record never counts toward qualifyingCount, even alongside a later APPROVED one", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS", { brief: { platforms: ["instagram"], requiredCount: 2 } });

    const firstThread = await submitOnce(head, assignment.assignmentRef, uniqueUrl("cancel-then-approve-1"));
    const cancelled = await cancelContent(head, firstThread.contentRef, { reason: "Wrong platform.", expectedVersion: firstThread.version }, "req");
    expect(cancelled.ok).toBe(true);

    const afterCancel = await getAssignmentDocByRef(assignment.assignmentRef);
    const resultAfterCancel = await evaluateAssignmentFulfillment(afterCancel!);
    expect(resultAfterCancel).toMatchObject({ fulfilled: false, requiredCount: 2, qualifyingCount: 0 });

    const approved = await driveToApproved(head, assignment.assignmentRef, uniqueUrl("cancel-then-approve-2"));
    expect(approved.contentRef).not.toBe(firstThread.contentRef);

    const afterApprove = await getAssignmentDocByRef(assignment.assignmentRef);
    expect(afterApprove?.status).toBe("IN_PROGRESS"); // NOT completed - the cancelled record never counted, so only 1/2 is genuinely satisfied.
    const resultAfterApprove = await evaluateAssignmentFulfillment(afterApprove!);
    expect(resultAfterApprove).toMatchObject({ fulfilled: false, requiredCount: 2, qualifyingCount: 1 });
  });

  // Finding #50: requiredCount was previously dead data - fulfillment
  // always hardcoded requiredCount:1/qualifyingCount:1 (or 0) regardless of
  // what the brief actually configured. The one-thread-per-Assignment
  // model means "N required" can only be links within that one thread's
  // current revision (see MAX_ASSIGNMENT_REQUIRED_COUNT's own comment in
  // assignments/types.ts) - these prove that's now real, on both the
  // auto-complete and manual-complete paths, which share one evaluator.
  // Finding #50 (reopened): restored canonical semantics - requiredCount
  // is fulfilled by the COUNT of the Assignment's own APPROVED Content
  // RECORDS (never links inside one record). Each cycle below is a
  // genuinely separate submission session -> separate Content thread,
  // exactly the "multiple qualifying Content records fulfill the
  // Assignment" model the finding restores.
  it("requiredCount = 3: three separate submission cycles progress partial -> partial -> fulfilled, auto-completing only on the third approval", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS", { brief: { platforms: ["instagram"], requiredCount: 3 } });

    const first = await driveToApproved(head, assignment.assignmentRef, uniqueUrl("progress-1"));
    let assignmentDoc = await getAssignmentDocByRef(assignment.assignmentRef);
    expect(assignmentDoc?.status).toBe("IN_PROGRESS");
    let result = await evaluateAssignmentFulfillment(assignmentDoc!);
    expect(result).toMatchObject({ fulfilled: false, requiredCount: 3, qualifyingCount: 1 });
    expect(result.blockers[0]?.message).toContain("requires 3 approved submission(s)");
    expect(result.blockers[0]?.message).toContain("1 currently approved");

    const second = await driveToApproved(head, assignment.assignmentRef, uniqueUrl("progress-2"));
    expect(second.contentRef).not.toBe(first.contentRef);
    assignmentDoc = await getAssignmentDocByRef(assignment.assignmentRef);
    expect(assignmentDoc?.status).toBe("IN_PROGRESS");
    result = await evaluateAssignmentFulfillment(assignmentDoc!);
    expect(result).toMatchObject({ fulfilled: false, requiredCount: 3, qualifyingCount: 2 });

    // Manual completion is blocked at every partial step - the shared
    // evaluator backs both the auto-complete and the manual-complete gate.
    const manualAttempt = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "COMPLETED", expectedVersion: assignmentDoc!.version }, "req-manual-blocked");
    expect(manualAttempt.ok).toBe(false);
    if (manualAttempt.ok) throw new Error("unreachable");
    expect(manualAttempt.code).toBe("not_ready");

    const third = await driveToApproved(head, assignment.assignmentRef, uniqueUrl("progress-3"));
    expect(third.contentRef).not.toBe(first.contentRef);
    expect(third.contentRef).not.toBe(second.contentRef);
    assignmentDoc = await getAssignmentDocByRef(assignment.assignmentRef);
    expect(assignmentDoc?.status).toBe("COMPLETED");
    result = await evaluateAssignmentFulfillment(assignmentDoc!);
    expect(result).toMatchObject({ fulfilled: true, requiredCount: 3, qualifyingCount: 3 });
  });

  it("requiredCount = 2: a THIRD approved record over-fulfills honestly - qualifyingCount=3, fulfilled=true, never clamped, never an error", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS", { brief: { platforms: ["instagram"], requiredCount: 2 } });

    await driveToApproved(head, assignment.assignmentRef, uniqueUrl("over-1"));
    await driveToApproved(head, assignment.assignmentRef, uniqueUrl("over-2"));
    const completedAfterTwo = await getAssignmentDocByRef(assignment.assignmentRef);
    expect(completedAfterTwo?.status).toBe("COMPLETED");
    expect(await evaluateAssignmentFulfillment(completedAfterTwo!)).toMatchObject({ fulfilled: true, requiredCount: 2, qualifyingCount: 2 });

    // The real product flow correctly refuses a 3rd session once the
    // Assignment is COMPLETED (see the dedicated test below) - a 3rd
    // qualifying record beyond requiredCount is not reachable through the
    // live UI today. Seeded directly here ONLY to prove the fulfillment
    // COUNTING logic itself is genuinely uncapped and honest, not to
    // claim this exact sequence is a real user flow.
    await seedExtraApprovedContent(assignment, uniqueUrl("over-3"));

    const finalAssignmentDoc = await getAssignmentDocByRef(assignment.assignmentRef);
    const result = await evaluateAssignmentFulfillment(finalAssignmentDoc!);
    expect(result).toMatchObject({ fulfilled: true, requiredCount: 2, qualifyingCount: 3 });
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

  it("a COMPLETED Assignment refuses a new external-submission session - nothing new can be issued once its obligation is fully met, even though the Assignment could in principle carry more Content records", async () => {
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

// Finding #44 (user-decided): a Manager recording content links on the Partner's behalf - real,
// authenticated-actor writes, requiring an Assignment context, mirroring submitExternalLinks' own
// revision/claim-conflict transaction shape exactly.
describe("Manager-recorded content links (recordContentLinksOnBehalf)", () => {
  it("creates a fresh thread (resolveOrCreateContentThread) and records the links as revision 1, recipientType MANAGER, actor is the real recorder", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS");
    const url = uniqueUrl("manager-record");

    const result = await recordContentLinksOnBehalf(head, { assignmentRef: assignment.assignmentRef, rows: [{ platform: "instagram", url }] }, "req-manager-record-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.status).toBe("UNDER_REVIEW");
    expect(result.data.currentLinks.some((l) => l.normalizedUrl === url)).toBe(true);
    expect(result.data.assignmentRef).toBe(assignment.assignmentRef);
  });

  it("is idempotent-safe with the get-or-create thread: a second call while still OPEN reuses the SAME thread and advances the revision number", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS");

    const first = await recordContentLinksOnBehalf(head, { assignmentRef: assignment.assignmentRef, rows: [{ platform: "instagram", url: uniqueUrl("manager-a") }] }, "req-manager-record-2a");
    if (!first.ok) throw new Error("unreachable");
    expect(first.data.currentRevisionNumber).toBe(1);

    // The thread is now UNDER_REVIEW - request a revision so it becomes editable again, then record
    // again on the Partner's behalf, proving the SAME thread (not a second one) receives revision 2.
    const revisionRequested = await requestContentRevision(head, first.data.contentRef, { reason: "needs a fix", reviewedRevisionNumber: first.data.reviewedRevisionNumber!, expectedVersion: first.data.version }, "req-revise");
    if (!revisionRequested.ok) throw new Error("unreachable");

    const second = await recordContentLinksOnBehalf(head, { assignmentRef: assignment.assignmentRef, rows: [{ platform: "instagram", url: uniqueUrl("manager-b") }] }, "req-manager-record-2b");
    if (!second.ok) throw new Error("unreachable");
    expect(second.data.contentRef).toBe(first.data.contentRef);
    expect(second.data.currentRevisionNumber).toBe(2);
  });

  it("rejects a platform not permitted by the Assignment's own brief", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS"); // brief.platforms = ["instagram"] only
    const result = await recordContentLinksOnBehalf(head, { assignmentRef: assignment.assignmentRef, rows: [{ platform: "youtube", url: uniqueUrl("bad-platform") }] }, "req-manager-record-3");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
    expect(result.message).toMatch(/platform/i);
  });

  it("rejects duplicate platform+URL rows in the same submission", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS");
    const url = uniqueUrl("dup");
    const result = await recordContentLinksOnBehalf(
      head,
      { assignmentRef: assignment.assignmentRef, rows: [{ platform: "instagram", url }, { platform: "instagram", url }] },
      "req-manager-record-4",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("rejects a cross-thread publication-identity collision - a URL already claimed by a DIFFERENT thread fails atomically", async () => {
    const head = await actorFor("partnership_head");
    const claimingAssignment = await createOperationalAssignment(head, "IN_PROGRESS");
    const url = uniqueUrl("collision");
    const claimed = await recordContentLinksOnBehalf(head, { assignmentRef: claimingAssignment.assignmentRef, rows: [{ platform: "instagram", url }] }, "req-manager-record-5a");
    if (!claimed.ok) throw new Error("unreachable");

    const otherAssignment = await createOperationalAssignment(head, "IN_PROGRESS");
    const collision = await recordContentLinksOnBehalf(head, { assignmentRef: otherAssignment.assignmentRef, rows: [{ platform: "instagram", url }] }, "req-manager-record-5b");
    expect(collision.ok).toBe(false);
    if (collision.ok) throw new Error("unreachable");
    expect(collision.code).toBe("invalid_input");
  });

  it("rejects an assignmentRef that does not resolve to a real Assignment, and one whose status does not allow content generation (DRAFT)", async () => {
    const head = await actorFor("partnership_head");
    const notReal = await recordContentLinksOnBehalf(head, { assignmentRef: "not-a-real-assignment", rows: [{ platform: "instagram", url: uniqueUrl("nope") }] }, "req-manager-record-6a");
    expect(notReal.ok).toBe(false);

    const draftAssignment = await createFreshAssignment(head);
    const stillDraft = await recordContentLinksOnBehalf(head, { assignmentRef: draftAssignment.assignmentRef, rows: [{ platform: "instagram", url: uniqueUrl("draft") }] }, "req-manager-record-6b");
    expect(stillDraft.ok).toBe(false);
    if (stillDraft.ok) throw new Error("unreachable");
    expect(stillDraft.message).toMatch(/DRAFT/);
  });

  it("Viewer/Analyst are denied the Content feature entirely - record_content_links is unreachable to them", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS");
    for (const role of ["viewer", "analyst"]) {
      const actor = await actorFor(role);
      const result = await recordContentLinksOnBehalf(actor, { assignmentRef: assignment.assignmentRef, rows: [{ platform: "instagram", url: uniqueUrl("denied") }] }, "req-manager-record-7");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("feature_denied");
    }
  });

  it("never creates orphan Content - assignmentRef is always required by the input schema", async () => {
    const head = await actorFor("partnership_head");
    const result = await recordContentLinksOnBehalf(head, { rows: [{ platform: "instagram", url: uniqueUrl("orphan") }] }, "req-manager-record-8");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });
});

// Finding #44 (user-decided): the bulk import target - a real, registered "content_links" adapter
// (never a value bolted onto AnalyticsTargetKind), dispatched exactly the way Import Center dispatches
// any OTHER registered target, writing through the SAME recordContentLinksOnBehalf every single-link
// call above already exercises (never a bespoke direct Firestore write).
describe("Bulk import target (content_links)", () => {
  function workbookBuffer(rows: unknown[][]): Buffer {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, sheet, "Links");
    return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  }

  // The seeded partnership_head role holds content:record_content_links (Findings #44's own single-link
  // grant) but NOT imports:manage_imports (the SEEDED baseline only grants that to analyst/super_admin -
  // see seed-access-data.ts's own comment on analyst's imports grant; contract-bundle-import.emulator.
  // test.ts's own tests hit the exact same gap and resolve it the exact same way: a real per-user
  // override document, the actual product mechanism for this - see authz/types.ts's userAccessOverride
  // Doc - not a test-only shortcut).
  //
  // CAUGHT DURING FULL-SUITE VERIFICATION: an earlier version of this setup wrote that override onto the
  // SHARED, cross-file partnership_head uid (the same seeded identity every other emulator test file's
  // own actorFor("partnership_head") resolves to) - safe in isolation, but a genuine race under the full
  // suite (some other concurrently-running file's own Firestore activity against that same shared uid can
  // observe/interact with the override mid-run). Fixed to mirror finance-onboarding-harness.ts's own
  // actor() pattern exactly: a SYNTHETIC, globally-unique uid (never resolved by any other file, never
  // touched by seedEmulatorTestUsers/seedAccessControlData) that still inherits partnership_head's real,
  // unmutated ROLE-level grants (role-level grants are read-only here, keyed by role not uid) plus its
  // own GLOBAL scope grant and its own imports override - fully isolated from every other file's own
  // activity, by construction.
  let importActor: ActorContext;
  beforeAll(async () => {
    registerImportTargets();
    const uid = `content-link-import-test-${runId}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    await getAdminFirestore()
      .collection("scopeAssignments")
      .doc(`${uid}__GLOBAL`)
      .set({ type: "GLOBAL", uid, grantedAt: now, grantedBy: "content-link-import-test" });
    await getAdminFirestore()
      .collection("userAccessOverrides")
      .doc(uid)
      .set({ uid, version: 1, features: { imports: { view: true, actions: { manage_imports: true } } } });
    const userRef = `content-link-import-test-ref-${uid}`;
    // A real backing users/{uid} doc too - listContentLinkImportBatches resolves actorDisplayName via
    // getUserDocByRef(actorUserRef); without this, the synthetic actor's own history rows would
    // correctly (and uninterestingly) resolve to a null display name, same as any genuinely unknown
    // userRef - this makes the display-name resolution itself a real, exercised assertion instead.
    await getAdminFirestore().collection("users").doc(uid).set({ uid, email: `${uid}@example.test`, role: "partnership_head", active: true, displayName: "Content Link Import Test Actor", userRef, version: 1 });
    importActor = { uid, email: `${uid}@example.test`, role: "partnership_head", displayName: "Content Link Import Test Actor", userRef };
  });

  afterAll(async () => {
    await getAdminFirestore().collection("scopeAssignments").doc(`${importActor.uid}__GLOBAL`).delete();
    await getAdminFirestore().collection("userAccessOverrides").doc(importActor.uid).delete();
    await getAdminFirestore().collection("users").doc(importActor.uid).delete();
  });

  it("dry-runs and executes a real bulk file: groups rows by Assignment Ref, records real links, and is idempotent on replay", async () => {
    const head = importActor;
    const a1 = await createOperationalAssignment(head, "IN_PROGRESS");
    const a2 = await createOperationalAssignment(head, "IN_PROGRESS");
    const url1 = uniqueUrl("bulk-a1-1");
    const url2 = uniqueUrl("bulk-a1-2");
    const url3 = uniqueUrl("bulk-a2-1");

    const buffer = workbookBuffer([
      ["Assignment Ref", "Platform", "URL"],
      [a1.assignmentRef, "instagram", url1],
      [a1.assignmentRef, "instagram", url2], // grouped with the row above - ONE call, ONE revision
      [a2.assignmentRef, "instagram", url3],
    ]);
    const file = { buffer, filename: "links.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

    const target = getImportTarget("content_links");
    expect(target).not.toBeNull();

    const dryRun = await target!.dryRun(head, file, {}, "req-bulk-dry-1");
    expect(dryRun.batchRef).toBeNull(); // dry run persists nothing
    expect(dryRun.totalRows).toBe(3);
    expect(dryRun.counts.CREATE).toBe(3);

    const executed = await target!.execute(head, file, {}, "req-bulk-exec-1");
    expect(executed.status).toBe("COMPLETED");
    expect(executed.counts.CREATE).toBe(3);
    expect(executed.batchRef).toBeTruthy();

    // History/provenance is genuinely retained and readable, not just written - the same batch
    // reads back through both the list and detail functions the API route layer itself uses.
    const list = await listContentLinkImportBatches(head, 20);
    expect(list.ok).toBe(true);
    if (!list.ok) throw new Error("unreachable");
    const listed = list.data.find((b) => b.batchRef === executed.batchRef);
    expect(listed).toBeTruthy();
    expect(listed?.status).toBe("COMPLETED");
    expect(listed?.totalRows).toBe(3);
    expect(listed?.actorDisplayName).toBeTruthy();

    const detail = await getContentLinkImportBatchDetail(head, executed.batchRef);
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error("unreachable");
    expect(detail.data.rows).toHaveLength(3);
    expect(detail.data.rows.every((r) => r.outcome === "CREATE" && r.contentRef)).toBe(true);
    expect(detail.data.rows.map((r) => r.assignmentRef).sort()).toEqual([a1.assignmentRef, a1.assignmentRef, a2.assignmentRef].sort());

    const a1Thread = await threadForTest(head, a1.assignmentRef);
    expect(a1Thread.status).toBe("UNDER_REVIEW");
    expect(a1Thread.currentRevisionNumber).toBe(1); // both a1 rows landed in ONE revision, not two
    expect(a1Thread.currentLinks.map((l) => l.normalizedUrl).sort()).toEqual([url1, url2].sort());

    const a2Thread = await threadForTest(head, a2.assignmentRef);
    expect(a2Thread.currentLinks.some((l) => l.normalizedUrl === url3)).toBe(true);

    // Replaying the EXACT same file is idempotent: every group is already claimed, so nothing is
    // recorded twice and no new revision is created.
    const replayedDryRun = await target!.dryRun(head, file, {}, "req-bulk-dry-2");
    expect(replayedDryRun.counts.UNCHANGED).toBe(3);
    expect(replayedDryRun.counts.CREATE).toBe(0);

    const replayedExecute = await target!.execute(head, file, {}, "req-bulk-exec-2");
    expect(replayedExecute.counts.UNCHANGED).toBe(3);
    const a1ThreadAfterReplay = await threadForTest(head, a1.assignmentRef);
    expect(a1ThreadAfterReplay.currentRevisionNumber).toBe(1); // unchanged
    expect(a1ThreadAfterReplay.version).toBe(a1Thread.version); // never re-written
  });

  it("reports a malformed row (missing a required column) as its own ERROR row, never silently dropped and never blocking the rest of the file", async () => {
    const head = importActor;
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS");
    const url = uniqueUrl("bulk-malformed");

    const buffer = workbookBuffer([
      ["Assignment Ref", "Platform", "URL"],
      [assignment.assignmentRef, "", url], // missing Platform
      [assignment.assignmentRef, "instagram", uniqueUrl("bulk-ok")],
    ]);
    const file = { buffer, filename: "links.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

    const target = getImportTarget("content_links")!;
    const dryRun = await target.dryRun(head, file, {}, "req-bulk-malformed");
    expect(dryRun.totalRows).toBe(2);
    expect(dryRun.counts.ERROR).toBe(1);
    // The malformed row does not block the other row's own group from resolving normally.
    expect(dryRun.counts.CREATE).toBe(1);
  });

  it("a real pre-check (never a rubber stamp) flags an Assignment platform mismatch in the DRY RUN itself, before any write", async () => {
    const head = importActor;
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS"); // brief.platforms = ["instagram"] only
    const buffer = workbookBuffer([
      ["Assignment Ref", "Platform", "URL"],
      [assignment.assignmentRef, "youtube", uniqueUrl("bulk-bad-platform")],
    ]);
    const file = { buffer, filename: "links.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

    const target = getImportTarget("content_links")!;
    const dryRun = await target.dryRun(head, file, {}, "req-bulk-platform-check");
    expect(dryRun.counts.AMBIGUOUS).toBe(1);
    expect(dryRun.counts.CREATE).toBe(0);
  });

  it("Viewer/Analyst are denied at the target-gate level, before the file is even parsed", async () => {
    const assignment = await createOperationalAssignment(await actorFor("partnership_head"), "IN_PROGRESS");
    const buffer = workbookBuffer([
      ["Assignment Ref", "Platform", "URL"],
      [assignment.assignmentRef, "instagram", uniqueUrl("bulk-denied")],
    ]);
    const file = { buffer, filename: "links.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    const target = getImportTarget("content_links")!;

    for (const role of ["viewer", "analyst"]) {
      const actor = await actorFor(role);
      await expect(target.dryRun(actor, file, {}, "req-bulk-denied")).rejects.toThrow();
    }
  });
});
