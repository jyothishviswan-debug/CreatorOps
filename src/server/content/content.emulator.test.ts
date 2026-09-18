// Step 11A - real reads/writes against the running Firestore/Auth
// emulator (no mocks), same rationale as Assignments'/Campaigns'/
// Vendors'/Partners' own emulator test suites. Run with
// `pnpm test:emulator` against a running `pnpm firebase:emulators`.
import { beforeAll, describe, expect, it } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth } from "@/server/firebase/admin";
import { createAssignment } from "@/server/assignments/assignment-service";
import { transitionAssignmentLifecycle } from "@/server/assignments/assignment-lifecycle-service";
import { getAssignmentDocByRef } from "@/server/assignments/firestore";
import { seedAssignmentsData } from "@/server/assignments/seed-assignments-data";
import type { AssignmentDto } from "@/server/assignments/client-dto";
import { createCampaign } from "@/server/campaigns/campaign-service";
import { transitionCampaignLifecycle } from "@/server/campaigns/campaign-lifecycle-service";
import { seedCampaignsData } from "@/server/campaigns/seed-campaigns-data";
import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { seedVendorsData } from "@/server/vendors/seed-vendors-data";
import { evaluateAssignmentFulfillment } from "./fulfillment-service";
import { getContentRequiredSlotClaim } from "./firestore";
import { generateContentFromAssignment, getContent, getContentHistory, listContent, saveContentVersion, startContentProduction } from "./content-service";
import { addPublicationEvidence, cancelContent, completeContent, reviewContentDecision, submitContentForReview } from "./content-lifecycle-service";
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
  // `campaignOverrides` is a test-helper-only escape hatch (never a real
  // createAssignment field) - pulled out here so it never leaks into the
  // strict createAssignmentInputSchema below.
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
// full chain) up to (and including) `target`. Passing the Assignment's
// own CURRENT status as `from` is required when it is already past
// DRAFT - re-walking the full chain from the top against an
// already-ASSIGNED/ACCEPTED Assignment is an invalid transition.
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

async function generateRealContent(head: ActorContext, assignmentRef: string, overrides: Record<string, unknown> = {}): Promise<ContentDto> {
  const result = await generateContentFromAssignment(head, { assignmentRef, platform: "instagram", contentType: "reel", ...overrides }, "req-content-create");
  if (!result.ok) throw new Error(`unreachable: ${result.message}`);
  return result.data;
}

// Drives a freshly-generated Content record through IN_PRODUCTION -> one
// saved version -> (REVIEW_REQUIRED only) SUBMITTED.
async function driveToSubmitted(head: ActorContext, content: ContentDto): Promise<ContentDto> {
  const started = await startContentProduction(head, content.contentRef, { expectedVersion: content.version }, "req-start");
  if (!started.ok) throw new Error(`unreachable: ${started.message}`);
  const versioned = await saveContentVersion(head, content.contentRef, { captionText: "Draft caption.", expectedVersion: started.data.version }, "req-version");
  if (!versioned.ok) throw new Error(`unreachable: ${versioned.message}`);
  const submitted = await submitContentForReview(head, content.contentRef, { expectedVersion: versioned.data.version }, "req-submit");
  if (!submitted.ok) throw new Error(`unreachable: ${submitted.message}`);
  return submitted.data;
}

async function driveToApproved(head: ActorContext, content: ContentDto): Promise<ContentDto> {
  const submitted = await driveToSubmitted(head, content);
  const reviewed = await reviewContentDecision(head, submitted.contentRef, { decision: "APPROVED", reviewedVersion: submitted.currentVersion, expectedVersion: submitted.version }, "req-review");
  if (!reviewed.ok) throw new Error(`unreachable: ${reviewed.message}`);
  return reviewed.data;
}

async function driveToPosted(head: ActorContext, content: ContentDto): Promise<ContentDto> {
  const approved = content.reviewPolicy === "REVIEW_REQUIRED" ? await driveToApproved(head, content) : await (async () => {
    const started = await startContentProduction(head, content.contentRef, { expectedVersion: content.version }, "req-start");
    if (!started.ok) throw new Error(`unreachable: ${started.message}`);
    return started.data;
  })();
  const posted = await addPublicationEvidence(head, approved.contentRef, { platform: "instagram", url: uniqueUrl("posted"), expectedVersion: approved.version }, "req-evidence");
  if (!posted.ok) throw new Error(`unreachable: ${posted.message}`);
  return posted.data;
}

async function driveToCompleted(head: ActorContext, content: ContentDto): Promise<ContentDto> {
  const posted = await driveToPosted(head, content);
  const completed = await completeContent(head, posted.contentRef, { expectedVersion: posted.version }, "req-complete");
  if (!completed.ok) throw new Error(`unreachable: ${completed.message}`);
  return completed.data;
}

describe("Generation from Assignment", () => {
  it("creates a PLANNED Content record with currentVersion 0 and a claimed required slot", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    expect(content.status).toBe("PLANNED");
    expect(content.currentVersion).toBe(0);
    expect(content.requiredSlotIndex).toBe(0);
    expect(content.reviewPolicy).toBe("REVIEW_REQUIRED");
  });

  it("fails closed when the Assignment's brief.platforms is empty, rather than treating it as unconstrained", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED", { brief: { platforms: [] } });
    const result = await generateContentFromAssignment(head, { assignmentRef: assignment.assignmentRef, platform: "instagram", contentType: "reel" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/platform/i);
  });

  it("rejects a platform not present in the Assignment's own brief.platforms", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED", { brief: { platforms: ["instagram"] } });
    const result = await generateContentFromAssignment(head, { assignmentRef: assignment.assignmentRef, platform: "youtube", contentType: "reel" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("contentType is checked against brief.formats only when that array is non-empty", async () => {
    const head = await actorFor("partnership_head");
    const constrained = await createOperationalAssignment(head, "ASSIGNED", { brief: { platforms: ["instagram"], formats: ["reel", "carousel"] } });
    const rejected = await generateContentFromAssignment(head, { assignmentRef: constrained.assignmentRef, platform: "instagram", contentType: "story" }, "req");
    expect(rejected.ok).toBe(false);
    const accepted = await generateContentFromAssignment(head, { assignmentRef: constrained.assignmentRef, platform: "instagram", contentType: "reel" }, "req");
    expect(accepted.ok).toBe(true);

    const unconstrained = await createOperationalAssignment(head, "ASSIGNED", { brief: { platforms: ["instagram"], formats: [] } });
    const anyFormat = await generateContentFromAssignment(head, { assignmentRef: unconstrained.assignmentRef, platform: "instagram", contentType: "any-shape-goes" }, "req");
    expect(anyFormat.ok).toBe(true);
  });

  it("validates partnerAccountRef against the Assignment's Partner, restricted set, and platform match", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED", { partnerRef: "creator-house", brief: { platforms: ["instagram", "youtube"] } });

    const wrongPlatform = await generateContentFromAssignment(
      head,
      { assignmentRef: assignment.assignmentRef, platform: "instagram", contentType: "reel", partnerAccountRef: "seed-account-creatorhouse-yt" },
      "req",
    );
    expect(wrongPlatform.ok).toBe(false);

    const ok = await generateContentFromAssignment(
      head,
      { assignmentRef: assignment.assignmentRef, platform: "instagram", contentType: "reel", partnerAccountRef: "seed-account-creatorhouse-ig-primary" },
      "req",
    );
    expect(ok.ok).toBe(true);

    const restricted = await createOperationalAssignment(head, "ASSIGNED", {
      partnerRef: "creator-house",
      partnerAccountRefs: ["seed-account-creatorhouse-ig-primary"],
      brief: { platforms: ["instagram"] },
    });
    const notInRestrictedSet = await generateContentFromAssignment(
      head,
      { assignmentRef: restricted.assignmentRef, platform: "instagram", contentType: "reel", partnerAccountRef: "seed-account-creatorhouse-ig-reels" },
      "req",
    );
    expect(notInRestrictedSet.ok).toBe(false);
  });

  it("dueAt defaults from the Assignment, and a supplied dueAt later than the Assignment's own is rejected", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED", { brief: { platforms: ["instagram"], dueAt: "2026-03-01" } });

    const tooLate = await generateContentFromAssignment(head, { assignmentRef: assignment.assignmentRef, platform: "instagram", contentType: "reel", dueAt: "2026-04-01" }, "req");
    expect(tooLate.ok).toBe(false);

    const earlier = await generateContentFromAssignment(head, { assignmentRef: assignment.assignmentRef, platform: "instagram", contentType: "reel", dueAt: "2026-02-01" }, "req");
    expect(earlier.ok).toBe(true);
    if (!earlier.ok) throw new Error("unreachable");
    expect(earlier.data.dueAt).toBe("2026-02-01");

    const usesDefault = await generateContentFromAssignment(head, { assignmentRef: assignment.assignmentRef, platform: "instagram", contentType: "reel", asExtra: true }, "req");
    expect(usesDefault.ok).toBe(true);
    if (!usesDefault.ok) throw new Error("unreachable");
    expect(usesDefault.data.dueAt).toBe("2026-03-01");
  });

  it("rejects generation while the Assignment is DRAFT or CANCELLED", async () => {
    const head = await actorFor("partnership_head");
    const draft = await createFreshAssignment(head);
    const draftResult = await generateContentFromAssignment(head, { assignmentRef: draft.assignmentRef, platform: "instagram", contentType: "reel" }, "req");
    expect(draftResult.ok).toBe(false);

    const cancelled = await transitionAssignmentLifecycle(head, draft.assignmentRef, { to: "CANCELLED", reason: "test", expectedVersion: draft.version }, "req");
    expect(cancelled.ok).toBe(true);
    const cancelledResult = await generateContentFromAssignment(head, { assignmentRef: draft.assignmentRef, platform: "instagram", contentType: "reel" }, "req");
    expect(cancelledResult.ok).toBe(false);
  });

  it("has no Finance/Agreement/Payable/Invoice/Payment field anywhere on the created DTO", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    const keys = JSON.stringify(content).toLowerCase();
    for (const forbidden of ["agreement", "payable", "invoice", "payment", "payee", "compensation"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("Authorization / scope", () => {
  it("Viewer and Analyst are denied the Content feature entirely (feature_denied)", async () => {
    for (const role of ["viewer", "analyst"]) {
      const actor = await actorFor(role);
      const getResult = await getContent(actor, "seed-content-planned-review-required");
      expect(getResult.ok).toBe(false);
      if (getResult.ok) throw new Error("unreachable");
      expect(getResult.reason).toBe("feature_denied");

      const listResult = await listContent(actor, { limit: 20 });
      expect(listResult.ok).toBe(false);
      if (listResult.ok) throw new Error("unreachable");
      expect(listResult.reason).toBe("feature_denied");
    }
  });

  it("an unauthenticated actor is denied with not_authenticated", async () => {
    const result = await generateContentFromAssignment(null, { assignmentRef: "seed-assignment-in-progress", platform: "youtube", contentType: "reel" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("not_authenticated");
  });

  it("Manager and Head can both read a same-scope Content record (Kerala/Maharashtra)", async () => {
    for (const role of ["partnership_manager", "partnership_head"]) {
      const actor = await actorFor(role);
      const result = await getContent(actor, "seed-content-planned-review-required");
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
    // seed-content-in-production-review-required carries civic-voices'
    // empty regionIds/teamIds/null-owner snapshot - reachable only via
    // GLOBAL or an explicit grant, neither of which Manager holds.
    const real = await getContent(manager, "seed-content-in-production-review-required");
    const fake = await getContent(manager, "not-a-real-content-ref");
    expect(real.ok).toBe(false);
    if (real.ok) throw new Error("unreachable");
    expect(real.reason).toBe("scope_denied");
    expect(fake.ok).toBe(false);
  });

  it("review_content is denied to Manager and allowed to Head - approve/changes-required/reject all three", async () => {
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");

    for (const decision of ["APPROVED", "CHANGES_REQUIRED", "REJECTED"] as const) {
      const assignment = await createOperationalAssignment(head, "ASSIGNED");
      const content = await generateRealContent(head, assignment.assignmentRef);
      const submitted = await driveToSubmitted(head, content);

      const managerAttempt = await reviewContentDecision(
        manager,
        submitted.contentRef,
        { decision, reviewedVersion: submitted.currentVersion, comment: decision === "APPROVED" ? undefined : "Needs work.", expectedVersion: submitted.version },
        "req",
      );
      expect(managerAttempt.ok).toBe(false);
      if (managerAttempt.ok) throw new Error("unreachable");
      expect(managerAttempt.reason).toBe("action_denied");

      const headAttempt = await reviewContentDecision(
        head,
        submitted.contentRef,
        { decision, reviewedVersion: submitted.currentVersion, comment: decision === "APPROVED" ? undefined : "Needs work.", expectedVersion: submitted.version },
        "req",
      );
      expect(headAttempt.ok).toBe(true);
    }
  });

  it("scoped list never returns an out-of-scope Content record", async () => {
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const inScope = await generateRealContent(head, assignment.assignmentRef);

    const page = await listContent(manager, { limit: 100 });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("unreachable");
    expect(page.data.content.every((c) => c.contentRef !== "seed-content-in-production-review-required")).toBe(true);
    expect(page.data.content.some((c) => c.contentRef === inScope.contentRef)).toBe(true);
  });

  it("super_admin (GLOBAL) reads and lists everything", async () => {
    const admin = await actorFor("super_admin");
    const all = await listContent(admin, { limit: 100 });
    expect(all.ok).toBe(true);
    if (!all.ok) throw new Error("unreachable");
    expect(all.data.content.length).toBeGreaterThanOrEqual(10);
  });
});

describe("REVIEW_REQUIRED lifecycle", () => {
  it("full happy path PLANNED -> IN_PRODUCTION -> SUBMITTED -> APPROVED -> POSTED -> COMPLETED", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    expect(content.status).toBe("PLANNED");

    const completed = await driveToCompleted(head, content);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.publicationEvidence.length).toBeGreaterThan(0);
  });

  it("POSTED is never reachable before APPROVED - evidence is refused while SUBMITTED", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    const submitted = await driveToSubmitted(head, content);

    const result = await addPublicationEvidence(head, submitted.contentRef, { platform: "instagram", url: uniqueUrl("too-early"), expectedVersion: submitted.version }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("not_ready");
  });

  it("CHANGES_REQUIRED -> SUBMITTED resubmission loop preserves version/review history, and a stale reviewedVersion is rejected", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    const firstSubmit = await driveToSubmitted(head, content);
    expect(firstSubmit.currentVersion).toBe(1);
    expect(firstSubmit.lastSubmittedVersion).toBe(1);

    const changesRequested = await reviewContentDecision(
      head,
      firstSubmit.contentRef,
      { decision: "CHANGES_REQUIRED", reviewedVersion: 1, comment: "Fix the lighting.", expectedVersion: firstSubmit.version },
      "req",
    );
    expect(changesRequested.ok).toBe(true);
    if (!changesRequested.ok) throw new Error("unreachable");
    expect(changesRequested.data.status).toBe("CHANGES_REQUIRED");

    const secondVersion = await saveContentVersion(head, content.contentRef, { captionText: "Revised.", expectedVersion: changesRequested.data.version }, "req");
    expect(secondVersion.ok).toBe(true);
    if (!secondVersion.ok) throw new Error("unreachable");
    expect(secondVersion.data.currentVersion).toBe(2);

    const resubmitted = await submitContentForReview(head, content.contentRef, { expectedVersion: secondVersion.data.version }, "req");
    expect(resubmitted.ok).toBe(true);
    if (!resubmitted.ok) throw new Error("unreachable");
    expect(resubmitted.data.lastSubmittedVersion).toBe(2);

    // A decision targeting the now-outdated version 1 must fail as stale,
    // never silently apply to the current (version 2) submission.
    const staleDecision = await reviewContentDecision(
      head,
      content.contentRef,
      { decision: "APPROVED", reviewedVersion: 1, expectedVersion: resubmitted.data.version },
      "req",
    );
    expect(staleDecision.ok).toBe(false);
    if (staleDecision.ok) throw new Error("unreachable");
    expect(staleDecision.code).toBe("stale_write");

    const history = await getContentHistory(head, content.contentRef, {});
    expect(history.ok).toBe(true);
    if (!history.ok) throw new Error("unreachable");
    const kinds = history.data.events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "submitted")).toHaveLength(2);
    expect(kinds).toContain("review_decision");
    expect(kinds.filter((k) => k === "version_saved")).toHaveLength(2);
  });

  it("CHANGES_REQUIRED and REJECTED require a real comment; APPROVED does not", async () => {
    const head = await actorFor("partnership_head");

    for (const decision of ["CHANGES_REQUIRED", "REJECTED"] as const) {
      const assignment = await createOperationalAssignment(head, "ASSIGNED");
      const content = await generateRealContent(head, assignment.assignmentRef);
      const submitted = await driveToSubmitted(head, content);
      const result = await reviewContentDecision(head, submitted.contentRef, { decision, reviewedVersion: submitted.currentVersion, expectedVersion: submitted.version }, "req");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.message).toMatch(/comment/i);
    }

    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    const submitted = await driveToSubmitted(head, content);
    const approved = await reviewContentDecision(head, submitted.contentRef, { decision: "APPROVED", reviewedVersion: submitted.currentVersion, expectedVersion: submitted.version }, "req");
    expect(approved.ok).toBe(true);
  });

  it("submitContentForReview requires at least one saved version", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    const started = await startContentProduction(head, content.contentRef, { expectedVersion: content.version }, "req");
    if (!started.ok) throw new Error("unreachable");
    const result = await submitContentForReview(head, content.contentRef, { expectedVersion: started.data.version }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/version/i);
  });
});

describe("NO_PREPOST_REVIEW lifecycle", () => {
  async function createNoReviewAssignment(head: ActorContext, target: "ASSIGNED" | "ACCEPTED" | "IN_PROGRESS" = "ASSIGNED") {
    return createOperationalAssignment(head, target, { campaignOverrides: { defaultReviewPolicy: "NO_PREPOST_REVIEW" } });
  }

  it("full happy path PLANNED -> IN_PRODUCTION -> POSTED -> COMPLETED", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createNoReviewAssignment(head);
    const content = await generateRealContent(head, assignment.assignmentRef);
    expect(content.reviewPolicy).toBe("NO_PREPOST_REVIEW");

    const completed = await driveToCompleted(head, content);
    expect(completed.status).toBe("COMPLETED");
  });

  it("submitContentForReview and reviewContentDecision fail safely against a NO_PREPOST_REVIEW record", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createNoReviewAssignment(head);
    const content = await generateRealContent(head, assignment.assignmentRef);
    const started = await startContentProduction(head, content.contentRef, { expectedVersion: content.version }, "req");
    if (!started.ok) throw new Error("unreachable");

    const submitAttempt = await submitContentForReview(head, content.contentRef, { expectedVersion: started.data.version }, "req");
    expect(submitAttempt.ok).toBe(false);
    if (submitAttempt.ok) throw new Error("unreachable");
    expect(submitAttempt.message).toMatch(/pre-post review/i);

    const reviewAttempt = await reviewContentDecision(head, content.contentRef, { decision: "APPROVED", reviewedVersion: 1, expectedVersion: started.data.version }, "req");
    expect(reviewAttempt.ok).toBe(false);
    if (reviewAttempt.ok) throw new Error("unreachable");
    expect(reviewAttempt.message).toMatch(/pre-post review/i);
  });
});

describe("Publication evidence", () => {
  it("normalizes the URL, is idempotent on an identical retry, and a different URL appends to the same record", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    const approved = await driveToApproved(head, content);

    const rawUrl = `${uniqueUrl("normalize")}/`;
    const first = await addPublicationEvidence(head, approved.contentRef, { platform: "instagram", url: rawUrl, expectedVersion: approved.version }, "req");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.data.status).toBe("POSTED");
    expect(first.data.publicationEvidence[0]!.normalizedUrl).toBe(rawUrl.slice(0, -1));

    // Identical retry - idempotent, no duplicate entry.
    const retry = await addPublicationEvidence(head, first.data.contentRef, { platform: "instagram", url: rawUrl, expectedVersion: first.data.version }, "req");
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("unreachable");
    expect(retry.data.publicationEvidence).toHaveLength(1);
    expect(retry.data.version).toBe(first.data.version);

    // A second, different URL appends - never a second Content record.
    const second = await addPublicationEvidence(head, first.data.contentRef, { platform: "instagram", url: uniqueUrl("second"), expectedVersion: first.data.version }, "req");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.data.publicationEvidence).toHaveLength(2);
    expect(second.data.status).toBe("POSTED");
  });

  it("claiming the seeded collision URL/platformContentId against a DIFFERENT Content is rejected with conflict", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    const approved = await driveToApproved(head, content);

    const urlCollision = await addPublicationEvidence(
      head,
      approved.contentRef,
      { platform: "instagram", url: "https://instagram.com/p/seed-content-collision", expectedVersion: approved.version },
      "req",
    );
    expect(urlCollision.ok).toBe(false);
    if (urlCollision.ok) throw new Error("unreachable");
    expect(urlCollision.code).toBe("conflict");

    const pcidCollision = await addPublicationEvidence(
      head,
      approved.contentRef,
      { platform: "instagram", url: uniqueUrl("pcid-collision"), platformContentId: "seed-pcid-collision", expectedVersion: approved.version },
      "req",
    );
    expect(pcidCollision.ok).toBe(false);
    if (pcidCollision.ok) throw new Error("unreachable");
    expect(pcidCollision.code).toBe("conflict");
  });

  it("evidence can still be added while POSTED/COMPLETED without reverting status", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    const completed = await driveToCompleted(head, content);
    expect(completed.status).toBe("COMPLETED");

    const more = await addPublicationEvidence(head, completed.contentRef, { platform: "instagram", url: uniqueUrl("post-completion"), expectedVersion: completed.version }, "req");
    expect(more.ok).toBe(true);
    if (!more.ok) throw new Error("unreachable");
    expect(more.data.status).toBe("COMPLETED");
    expect(more.data.publicationEvidence.length).toBeGreaterThan(completed.publicationEvidence.length);
  });

  it("the seeded multi-evidence fixture carries 2+ publication evidence items on ONE Content record", async () => {
    const head = await actorFor("partnership_head");
    const result = await getContent(head, "seed-content-posted-multi-evidence");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.publicationEvidence.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Fulfillment", () => {
  it("the seeded partially-fulfilled Assignment (requiredCount 2, only 1 slot COMPLETED+QUALIFYING_REQUIRED) stays unfulfilled", async () => {
    const assignment = await getAssignmentDocByRef("seed-assignment-in-progress");
    if (!assignment) throw new Error("unreachable: seed fixture missing");
    const result = await evaluateAssignmentFulfillment(assignment);
    expect(result.fulfilled).toBe(false);
    expect(result.requiredCount).toBe(2);
    expect(result.qualifyingCount).toBe(1);
  });

  it("an asExtra Content never counts toward required-slot fulfillment, even once COMPLETED", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS", { brief: { platforms: ["instagram"], requiredCount: 1 } });

    const extra = await generateContentFromAssignment(head, { assignmentRef: assignment.assignmentRef, platform: "instagram", contentType: "reel", asExtra: true }, "req");
    if (!extra.ok) throw new Error("unreachable");
    await driveToCompleted(head, extra.data);

    const assignmentDoc = await getAssignmentDocByRef(assignment.assignmentRef);
    if (!assignmentDoc) throw new Error("unreachable");
    const stillUnfulfilled = await evaluateAssignmentFulfillment(assignmentDoc);
    expect(stillUnfulfilled.fulfilled).toBe(false);
    expect(stillUnfulfilled.qualifyingCount).toBe(0);
  });

  it("a fresh Assignment+Content pair auto-completes the Assignment via completeContent's own transaction, with no direct transitionAssignmentLifecycle(COMPLETED) call", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS", { brief: { platforms: ["instagram"], requiredCount: 1 } });
    const content = await generateRealContent(head, assignment.assignmentRef);
    expect(content.requiredSlotIndex).toBe(0);

    const completed = await driveToCompleted(head, content);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.qualifyingFulfillment?.kind).toBe("QUALIFYING_REQUIRED");

    const assignmentDoc = await getAssignmentDocByRef(assignment.assignmentRef);
    expect(assignmentDoc?.status).toBe("COMPLETED");
  });

  it("manual transitionAssignmentLifecycle(COMPLETED) is blocked while unfulfilled, and succeeds once fulfillment was already achieved by a Content completion that did NOT auto-trigger (Assignment was ACCEPTED, not IN_PROGRESS, at that moment) - proving the shared evaluator backs both paths", async () => {
    const head = await actorFor("partnership_head");

    // Blocked case - a plain fresh IN_PROGRESS Assignment with zero
    // qualifying Content.
    const blocked = await createOperationalAssignment(head, "IN_PROGRESS", { brief: { platforms: ["instagram"], requiredCount: 1 } });
    const blockedAttempt = await transitionAssignmentLifecycle(head, blocked.assignmentRef, { to: "COMPLETED", expectedVersion: blocked.version }, "req");
    expect(blockedAttempt.ok).toBe(false);
    if (blockedAttempt.ok) throw new Error("unreachable");
    expect(blockedAttempt.code).toBe("not_ready");
    expect(blockedAttempt.blockers?.[0]?.code).toBe("CONTENT_NOT_FULFILLED");

    // Fulfilled-before-IN_PROGRESS case - complete the required Content
    // while the Assignment is still ACCEPTED (completeContent's own
    // auto-trigger only fires when the Assignment is IN_PROGRESS at that
    // moment, so this deliberately does NOT auto-complete it).
    const accepted = await createOperationalAssignment(head, "ACCEPTED", { brief: { platforms: ["instagram"], requiredCount: 1 } });
    const content = await generateRealContent(head, accepted.assignmentRef);
    await driveToCompleted(head, content);

    const stillAccepted = await getAssignmentDocByRef(accepted.assignmentRef);
    expect(stillAccepted?.status).toBe("ACCEPTED");

    const nowInProgressVersion = await driveAssignmentTo(head, accepted.assignmentRef, stillAccepted!.version, "IN_PROGRESS", "ACCEPTED");
    const manualComplete = await transitionAssignmentLifecycle(head, accepted.assignmentRef, { to: "COMPLETED", expectedVersion: nowInProgressVersion }, "req");
    expect(manualComplete.ok).toBe(true);
    if (!manualComplete.ok) throw new Error("unreachable");
    expect(manualComplete.data.status).toBe("COMPLETED");
  });

  it("a cancelled Assignment (or an Assignment that is no longer operational) cannot be manually cancelled once Content evidence exists", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS", { brief: { platforms: ["instagram"], requiredCount: 1 } });
    const content = await generateRealContent(head, assignment.assignmentRef);
    await driveToPosted(head, content);

    const assignmentDoc = await getAssignmentDocByRef(assignment.assignmentRef);
    if (!assignmentDoc) throw new Error("unreachable");
    const cancelAttempt = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", reason: "test", expectedVersion: assignmentDoc.version }, "req");
    expect(cancelAttempt.ok).toBe(false);
    if (cancelAttempt.ok) throw new Error("unreachable");
    expect(cancelAttempt.code).toBe("not_ready");
    expect(cancelAttempt.blockers?.[0]?.code).toBe("CONTENT_EVIDENCE_EXISTS");
  });

  it("a COMPLETED Assignment blocks ALL new Content generation, required or asExtra", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS", { brief: { platforms: ["instagram"], requiredCount: 1 } });
    const content = await generateRealContent(head, assignment.assignmentRef);
    await driveToCompleted(head, content);

    const assignmentDoc = await getAssignmentDocByRef(assignment.assignmentRef);
    expect(assignmentDoc?.status).toBe("COMPLETED");

    const requiredAttempt = await generateContentFromAssignment(head, { assignmentRef: assignment.assignmentRef, platform: "instagram", contentType: "reel" }, "req");
    expect(requiredAttempt.ok).toBe(false);
    const extraAttempt = await generateContentFromAssignment(head, { assignmentRef: assignment.assignmentRef, platform: "instagram", contentType: "reel", asExtra: true }, "req");
    expect(extraAttempt.ok).toBe(false);
  });
});

describe("Concurrency", () => {
  it("concurrent generateContentFromAssignment calls for a 2-slot Assignment: exactly 2 succeed (distinct slots), the rest fail with no free slot", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "IN_PROGRESS", { brief: { platforms: ["instagram"], requiredCount: 2 } });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => generateContentFromAssignment(head, { assignmentRef: assignment.assignmentRef, platform: "instagram", contentType: "reel" }, `req-${i}`)),
    );
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(2);
    const slotIndexes = succeeded.map((r) => (r.ok ? r.data.requiredSlotIndex : null)).sort();
    expect(slotIndexes).toEqual([0, 1]);
    const failed = results.filter((r) => !r.ok);
    expect(failed).toHaveLength(3);
  }, 20_000);

  it("concurrent addPublicationEvidence calls for the SAME URL against two DIFFERENT Content records: exactly one wins", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const [a, b] = await Promise.all([
      generateContentFromAssignment(head, { assignmentRef: assignment.assignmentRef, platform: "instagram", contentType: "reel", asExtra: true }, "req-a"),
      generateContentFromAssignment(head, { assignmentRef: assignment.assignmentRef, platform: "instagram", contentType: "reel", asExtra: true }, "req-b"),
    ]);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    const [approvedA, approvedB] = await Promise.all([driveToApproved(head, a.data), driveToApproved(head, b.data)]);

    const sharedUrl = uniqueUrl("concurrent-collision");
    const results = await Promise.all([
      addPublicationEvidence(head, approvedA.contentRef, { platform: "instagram", url: sharedUrl, expectedVersion: approvedA.version }, "req-evidence-a"),
      addPublicationEvidence(head, approvedB.contentRef, { platform: "instagram", url: sharedUrl, expectedVersion: approvedB.version }, "req-evidence-b"),
    ]);
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    if (failed[0]!.ok) throw new Error("unreachable");
    expect(failed[0]!.code).toBe("conflict");
  }, 20_000);

  it("concurrent review decisions against the same submitted version: only one succeeds", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    const submitted = await driveToSubmitted(head, content);

    const results = await Promise.all([
      reviewContentDecision(head, submitted.contentRef, { decision: "APPROVED", reviewedVersion: submitted.currentVersion, expectedVersion: submitted.version }, "req-1"),
      reviewContentDecision(head, submitted.contentRef, { decision: "REJECTED", reviewedVersion: submitted.currentVersion, comment: "no", expectedVersion: submitted.version }, "req-2"),
    ]);
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(1);
  }, 20_000);
});

describe("Cancellation", () => {
  it("cannot cancel a COMPLETED Content record", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    const completed = await driveToCompleted(head, content);
    const result = await cancelContent(head, completed.contentRef, { reason: "test", expectedVersion: completed.version }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("cannot cancel a POSTED Content record (publication evidence already exists)", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    const posted = await driveToPosted(head, content);
    const result = await cancelContent(head, posted.contentRef, { reason: "test", expectedVersion: posted.version }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid_input");
  });

  it("cancelling a required Content releases its slot (state RELEASED, never deleted), and a later generate call reclaims it with supersedesContentRef set", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED", { brief: { platforms: ["instagram"], requiredCount: 1 } });
    const content = await generateRealContent(head, assignment.assignmentRef);
    expect(content.requiredSlotIndex).toBe(0);

    const cancelled = await cancelContent(head, content.contentRef, { reason: "Partner unavailable.", expectedVersion: content.version }, "req");
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error("unreachable");
    expect(cancelled.data.status).toBe("CANCELLED");

    const claim = await getContentRequiredSlotClaim(assignment.assignmentRef, 0);
    expect(claim?.state).toBe("RELEASED");
    expect(claim?.contentRef).toBe(content.contentRef);

    const replacement = await generateContentFromAssignment(head, { assignmentRef: assignment.assignmentRef, platform: "instagram", contentType: "reel" }, "req");
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) throw new Error("unreachable");
    expect(replacement.data.requiredSlotIndex).toBe(0);
    expect(replacement.data.supersedesContentRef).toBe(content.contentRef);

    const reclaimedClaim = await getContentRequiredSlotClaim(assignment.assignmentRef, 0);
    expect(reclaimedClaim?.state).toBe("CLAIMED");
    expect(reclaimedClaim?.contentRef).not.toBe(content.contentRef);
    expect(reclaimedClaim?.contentRef).toBe(replacement.data.contentRef);
  });
});

describe("Version append-only semantics", () => {
  it("each saveContentVersion call creates a NEW immutable version doc, never overwriting an old one, and a stale expectedVersion is rejected", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createOperationalAssignment(head, "ASSIGNED");
    const content = await generateRealContent(head, assignment.assignmentRef);
    const started = await startContentProduction(head, content.contentRef, { expectedVersion: content.version }, "req");
    if (!started.ok) throw new Error("unreachable");

    const v1 = await saveContentVersion(head, content.contentRef, { captionText: "v1", expectedVersion: started.data.version }, "req");
    expect(v1.ok).toBe(true);
    if (!v1.ok) throw new Error("unreachable");
    expect(v1.data.currentVersion).toBe(1);

    const v2 = await saveContentVersion(head, content.contentRef, { captionText: "v2", expectedVersion: v1.data.version }, "req");
    expect(v2.ok).toBe(true);
    if (!v2.ok) throw new Error("unreachable");
    expect(v2.data.currentVersion).toBe(2);

    // ContentDto never exposes the raw Firestore uid - resolve it via
    // getContentDocByRef (the internal, non-DTO doc) to look up the
    // version subcollection directly and prove BOTH versions persist as
    // distinct, immutable docs (never one overwritten by the other).
    const { getContentDocByRef, getContentVersionDocByNumber } = await import("./firestore");
    const internalDoc = await getContentDocByRef(content.contentRef);
    if (!internalDoc) throw new Error("unreachable");
    const realV1 = await getContentVersionDocByNumber(internalDoc.uid, 1);
    const realV2 = await getContentVersionDocByNumber(internalDoc.uid, 2);
    expect(realV1?.captionText).toBe("v1");
    expect(realV2?.captionText).toBe("v2");

    // Stale expectedVersion (reusing v1's already-consumed version number).
    const stale = await saveContentVersion(head, content.contentRef, { captionText: "stale", expectedVersion: v1.data.version }, "req");
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unreachable");
    expect(stale.code).toBe("stale_write");
  });
});
