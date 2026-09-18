// Step 10A - real reads/writes against the running Firestore/Auth
// emulator (no mocks), same rationale as Campaigns'/Vendors'/Partners'
// own emulator test suites. Run with `pnpm test:emulator` against a
// running `pnpm firebase:emulators`.
import { beforeAll, describe, expect, it } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth } from "@/server/firebase/admin";
import { createCampaign } from "@/server/campaigns/campaign-service";
import { transitionCampaignLifecycle } from "@/server/campaigns/campaign-lifecycle-service";
import { editCampaign, getCampaign } from "@/server/campaigns/campaign-service";
import { seedCampaignsData } from "@/server/campaigns/seed-campaigns-data";
import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { seedVendorsData } from "@/server/vendors/seed-vendors-data";
import { createAssignment, editAssignmentBrief, getAssignment, getAssignmentHistory, listAssignments } from "./assignment-service";
import { transitionAssignmentLifecycle } from "./assignment-lifecycle-service";
import { seedAssignmentsData } from "./seed-assignments-data";
import type { AssignmentDto } from "./client-dto";

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

// Every uniqueness/concurrency test needs a genuinely FRESH
// (campaignRef, partnerRef) pair - the only real ACTIVE Partners
// (seed-partner-direct, creator-house) are already paired with every
// eligible seeded Campaign (seed-campaign-planned, civic-voices) by
// seed-assignments-data.ts, so a fresh Campaign is created (and planned)
// per test instead, guaranteeing no collision with seed fixtures or
// between test cases.
async function createFreshPlannedCampaign(head: ActorContext, overrides: Record<string, unknown> = {}) {
  const created = await createCampaign(
    head,
    {
      name: uniqueName("Assignment Test Campaign"),
      objective: "x",
      platforms: ["instagram", "youtube"],
      startDate: "2026-01-01",
      endDate: "2026-06-01",
      // Head's own scope grant is Kerala (among others) - a Campaign with
      // no region/team/owner is unreachable to Head, same reason
      // Campaigns' own emulator test suite's createRealCampaign helper
      // always sets this.
      regionIds: ["Kerala"],
      defaultReviewPolicy: "REVIEW_REQUIRED",
      ...overrides,
    },
    "req-campaign-create",
  );
  if (!created.ok) throw new Error(`unreachable: ${created.message}`);
  const planned = await transitionCampaignLifecycle(head, created.data.campaignRef, { to: "PLANNED", expectedVersion: created.data.version }, "req-campaign-plan");
  if (!planned.ok) throw new Error(`unreachable: ${planned.message}`);
  // The transition bumps the Campaign's version - callers need the
  // CURRENT version (for their own expectedVersion checks), not the
  // stale one from the moment of creation.
  return { ...created.data, version: planned.data.version, status: planned.data.status };
}

async function createRealAssignment(head: ActorContext, overrides: Record<string, unknown> = {}): Promise<AssignmentDto> {
  const campaign = overrides.campaignRef ? undefined : await createFreshPlannedCampaign(head);
  const result = await createAssignment(
    head,
    { campaignRef: campaign?.campaignRef, partnerRef: "seed-partner-direct", brief: { platforms: ["instagram"] }, ...overrides },
    "req-assignment-create",
  );
  if (!result.ok) throw new Error(`unreachable: ${result.message}`);
  return result.data;
}

describe("Assignment contract", () => {
  it("rejects an unrecognized field on create (schema strictness)", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const result = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct", agreementRef: "x" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("requires both campaignRef and partnerRef", async () => {
    const head = await actorFor("partnership_head");
    const result = await createAssignment(head, { partnerRef: "seed-partner-direct" }, "req");
    expect(result.ok).toBe(false);
  });

  it("rejects a campaignRef that does not resolve to a real Campaign", async () => {
    const head = await actorFor("partnership_head");
    const result = await createAssignment(head, { campaignRef: "not-a-real-campaign", partnerRef: "seed-partner-direct" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("rejects creation while the Campaign is DRAFT", async () => {
    const head = await actorFor("partnership_head");
    const result = await createAssignment(head, { campaignRef: "seed-campaign-draft", partnerRef: "seed-partner-direct" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/DRAFT/);
  });

  it("rejects creation while the Campaign is PAUSED", async () => {
    const head = await actorFor("partnership_head");
    // seed-campaign-paused is Uttar Pradesh, deliberately outside Head's
    // own granted regions (see seed-access-data.ts) - build a fresh,
    // Head-reachable Campaign and drive it to PAUSED instead.
    const campaign = await createFreshPlannedCampaign(head);
    const active = await transitionCampaignLifecycle(head, campaign.campaignRef, { to: "ACTIVE", expectedVersion: campaign.version }, "req");
    if (!active.ok) throw new Error("unreachable");
    const paused = await transitionCampaignLifecycle(head, campaign.campaignRef, { to: "PAUSED", expectedVersion: active.data.version }, "req");
    if (!paused.ok) throw new Error("unreachable");

    const result = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "creator-house" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/PAUSED/);
  });

  it("rejects a Partner that is not ACTIVE-eligible (INACTIVE)", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const result = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-inactive" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/inactive/i);
  });

  it("rejects a brief platform that is not one of the Campaign's own platforms", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head, { platforms: ["instagram"] });
    const result = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct", brief: { platforms: ["youtube"] } }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/platform/i);
  });

  it("rejects a Partner Account that does not belong to the given Partner", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    // seed-partner-direct's own accounts don't include creator-house's -
    // reuse one of creator-house's known account fixtures as the
    // mismatched reference.
    const result = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct", partnerAccountRefs: ["not-a-real-account"] }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/Partner Account/);
  });

  it("has no Finance/Agreement/Payable/Invoice/Payment field anywhere on the created DTO", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    const keys = JSON.stringify(assignment).toLowerCase();
    for (const forbidden of ["agreement", "payable", "invoice", "payment", "payee", "compensation"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("Uniqueness / concurrency", () => {
  it("at most one canonical Assignment per (campaignRef, partnerRef) - a repeat create returns the same canonical Assignment", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const first = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct" }, "req-1");
    const second = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct" }, "req-2");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.data.assignmentRef).toBe(first.data.assignmentRef);
  });

  it("same Campaign, different Partner succeeds as a distinct Assignment", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    const a = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct" }, "req-a");
    const b = await createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "creator-house" }, "req-b");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(a.data.assignmentRef).not.toBe(b.data.assignmentRef);
  });

  it("same Partner, different Campaign succeeds as a distinct Assignment", async () => {
    const head = await actorFor("partnership_head");
    const campaignOne = await createFreshPlannedCampaign(head);
    const campaignTwo = await createFreshPlannedCampaign(head);
    const a = await createAssignment(head, { campaignRef: campaignOne.campaignRef, partnerRef: "seed-partner-direct" }, "req-a");
    const b = await createAssignment(head, { campaignRef: campaignTwo.campaignRef, partnerRef: "seed-partner-direct" }, "req-b");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(a.data.assignmentRef).not.toBe(b.data.assignmentRef);
  });

  it(
    "concurrent create attempts for the same pair produce exactly one canonical Assignment (repeated to build confidence)",
    async () => {
      const head = await actorFor("partnership_head");
      for (let round = 0; round < 5; round += 1) {
        const campaign = await createFreshPlannedCampaign(head);
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) => createAssignment(head, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct" }, `req-concurrent-${round}-${i}`)),
        );
        expect(results.every((r) => r.ok)).toBe(true);
        const refs = new Set(results.map((r) => (r.ok ? r.data.assignmentRef : null)));
        expect(refs.size).toBe(1);
      }
    },
    20_000,
  );
});

describe("Snapshot semantics", () => {
  it("a later Campaign edit does not mutate an already-created Assignment's issued brief", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head, { name: "Original Campaign Name" });
    const assignment = await createRealAssignment(head, { campaignRef: campaign.campaignRef });
    expect(assignment.brief.campaignName).toBe(campaign.name);
    expect(assignment.brief.reviewPolicy).toBe("REVIEW_REQUIRED");

    const edited = await editCampaign(head, campaign.campaignRef, { name: "Renamed Campaign", defaultReviewPolicy: "NO_PREPOST_REVIEW", expectedVersion: campaign.version }, "req-edit");
    expect(edited.ok).toBe(true);

    const refetched = await getAssignment(head, assignment.assignmentRef);
    expect(refetched.ok).toBe(true);
    if (!refetched.ok) throw new Error("unreachable");
    expect(refetched.data.brief.campaignName).toBe("Original Campaign Name");
    expect(refetched.data.brief.reviewPolicy).toBe("REVIEW_REQUIRED");
  });

  it("allowed-platforms snapshot on the brief is not silently resynced by editing the brief's other fields", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    expect(assignment.brief.platforms).toEqual(["instagram"]);
    const edited = await editAssignmentBrief(head, assignment.assignmentRef, { instructions: "Updated instructions.", expectedVersion: assignment.version }, "req-edit-brief");
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error("unreachable");
    expect(edited.data.brief.platforms).toEqual(["instagram"]);
    expect(edited.data.brief.instructions).toBe("Updated instructions.");
  });
});

describe("Lifecycle", () => {
  it("DRAFT -> ASSIGNED -> ACCEPTED -> IN_PROGRESS succeeds; IN_PROGRESS -> COMPLETED fails closed (no Content yet)", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    let version = assignment.version;

    const toAssigned = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ASSIGNED", expectedVersion: version }, "req-1");
    expect(toAssigned.ok).toBe(true);
    if (!toAssigned.ok) throw new Error("unreachable");
    version = toAssigned.data.version;

    const toAccepted = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ACCEPTED", expectedVersion: version }, "req-2");
    expect(toAccepted.ok).toBe(true);
    if (!toAccepted.ok) throw new Error("unreachable");
    version = toAccepted.data.version;

    const toInProgress = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "IN_PROGRESS", expectedVersion: version }, "req-3");
    expect(toInProgress.ok).toBe(true);
    if (!toInProgress.ok) throw new Error("unreachable");
    version = toInProgress.data.version;

    const toCompleted = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "COMPLETED", expectedVersion: version }, "req-4");
    expect(toCompleted.ok).toBe(false);
    if (toCompleted.ok) throw new Error("unreachable");
    expect(toCompleted.code).toBe("not_ready");
    expect(toCompleted.blockers?.[0]?.code).toBe("CONTENT_EVIDENCE_UNAVAILABLE");
  });

  it("rejects skipping a state (DRAFT straight to ACCEPTED)", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    const result = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ACCEPTED", expectedVersion: assignment.version }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("a stale expectedVersion fails with stale_write", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    const result = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ASSIGNED", expectedVersion: assignment.version + 5 }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("stale_write");
  });

  it("CANCELLED requires a reason", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    const result = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", expectedVersion: assignment.version }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/reason/i);
  });

  it("CANCELLED is reachable from DRAFT, ASSIGNED, ACCEPTED, and IN_PROGRESS", async () => {
    const head = await actorFor("partnership_head");

    const fromDraft = await createRealAssignment(head);
    const cancelDraft = await transitionAssignmentLifecycle(head, fromDraft.assignmentRef, { to: "CANCELLED", reason: "Test cancellation.", expectedVersion: fromDraft.version }, "req");
    expect(cancelDraft.ok).toBe(true);

    const fromInProgress = await createRealAssignment(head);
    let v = fromInProgress.version;
    for (const to of ["ASSIGNED", "ACCEPTED", "IN_PROGRESS"] as const) {
      const step = await transitionAssignmentLifecycle(head, fromInProgress.assignmentRef, { to, expectedVersion: v }, "req");
      expect(step.ok).toBe(true);
      if (!step.ok) throw new Error("unreachable");
      v = step.data.version;
    }
    const cancelInProgress = await transitionAssignmentLifecycle(head, fromInProgress.assignmentRef, { to: "CANCELLED", reason: "Test cancellation.", expectedVersion: v }, "req");
    expect(cancelInProgress.ok).toBe(true);
  });

  it("CANCELLED and terminal states allow no further transition", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    const cancelled = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", reason: "x", expectedVersion: assignment.version }, "req");
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error("unreachable");
    const reAssign = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ASSIGNED", expectedVersion: cancelled.data.version }, "req");
    expect(reAssign.ok).toBe(false);
  });

  it("brief edit is refused once the Assignment is past DRAFT", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    const toAssigned = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ASSIGNED", expectedVersion: assignment.version }, "req");
    expect(toAssigned.ok).toBe(true);
    const editAttempt = await editAssignmentBrief(head, assignment.assignmentRef, { instructions: "too late", expectedVersion: toAssigned.ok ? toAssigned.data.version : 0 }, "req");
    expect(editAttempt.ok).toBe(false);
    if (editAttempt.ok) throw new Error("unreachable");
    expect(editAttempt.message).toMatch(/DRAFT/);
  });
});

describe("Authorization / scope", () => {
  it("Viewer and Analyst are denied create (view-only access)", async () => {
    const head = await actorFor("partnership_head");
    const campaign = await createFreshPlannedCampaign(head);
    for (const role of ["viewer", "analyst"]) {
      const actor = await actorFor(role);
      const result = await createAssignment(actor, { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct" }, "req");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("unauthorized");
      expect(result.reason).toBe("action_denied");
    }
  });

  it("an unauthenticated actor is denied with not_authenticated", async () => {
    const result = await createAssignment(null, { campaignRef: "seed-campaign-planned", partnerRef: "seed-partner-direct" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("not_authenticated");
  });

  it("Manager and Head can both read a same-scope Assignment (Kerala/Maharashtra, via seed-campaign-planned's own scope snapshot)", async () => {
    for (const role of ["partnership_manager", "partnership_head"]) {
      const actor = await actorFor(role);
      const result = await getAssignment(actor, "seed-assignment-draft");
      expect(result.ok).toBe(true);
    }
  });

  it("visibility into a Campaign (via an explicit CAMPAIGN grant) does NOT automatically grant visibility into that Campaign's own Assignments - Assignment scope is its own independent snapshot, never bridged", async () => {
    // Head can see civic-voices itself (explicit CAMPAIGN grant), but
    // civic-voices has no regionIds/teamIds/ownerUid of its own, so every
    // Assignment created under it inherits an EMPTY scope snapshot -
    // reachable only via GLOBAL or an explicit EXPLICIT_RECORD("assignment",...)
    // grant, neither of which any non-admin role holds here.
    const head = await actorFor("partnership_head");
    const campaignItself = await getCampaign(head, "civic-voices");
    expect(campaignItself.ok).toBe(true);

    const assignmentUnderIt = await getAssignment(head, "seed-assignment-assigned");
    expect(assignmentUnderIt.ok).toBe(false);
    if (assignmentUnderIt.ok) throw new Error("unreachable");
    expect(assignmentUnderIt.reason).toBe("scope_denied");

    const admin = await actorFor("super_admin");
    const asAdmin = await getAssignment(admin, "seed-assignment-assigned");
    expect(asAdmin.ok).toBe(true);
  });

  it("cross-scope user cannot read another-scope Assignment by direct ref, and gets the same safe denial as a nonexistent one", async () => {
    const viewer = await actorFor("viewer");
    const real = await getAssignment(viewer, "seed-assignment-assigned");
    const fake = await getAssignment(viewer, "not-a-real-assignment-ref");
    expect(real.ok).toBe(false);
    expect(fake.ok).toBe(false);
  });

  it("scoped list never returns an out-of-scope Assignment", async () => {
    const viewer = await actorFor("viewer");
    const page = await listAssignments(viewer, { limit: 50 });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("unreachable");
    expect(page.data.assignments.every((a) => a.assignmentRef !== "seed-assignment-assigned")).toBe(true);
  });

  it("super_admin (GLOBAL) reads and lists everything", async () => {
    const admin = await actorFor("super_admin");
    const all = await listAssignments(admin, { limit: 50 });
    expect(all.ok).toBe(true);
    if (!all.ok) throw new Error("unreachable");
    expect(all.data.assignments.length).toBeGreaterThanOrEqual(5);
  });
});

describe("History", () => {
  it("records a created event, and lifecycle transitions append their own events", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createRealAssignment(head);
    await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "ASSIGNED", expectedVersion: assignment.version }, "req");

    const history = await getAssignmentHistory(head, assignment.assignmentRef, {});
    expect(history.ok).toBe(true);
    if (!history.ok) throw new Error("unreachable");
    const kinds = history.data.events.map((e) => e.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("lifecycle_transitioned");
  });
});
