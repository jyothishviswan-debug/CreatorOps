// Step 10A - real reads/writes against the running Firestore/Auth
// emulator (no mocks). Kept as its own file, separate from
// assignments.emulator.test.ts, given this is a distinct security surface
// (the one genuinely unauthenticated flow in the app). Run with
// `pnpm test:emulator` against a running `pnpm firebase:emulators`.
import { beforeAll, describe, expect, it } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminAuth } from "@/server/firebase/admin";
import { createCampaign } from "@/server/campaigns/campaign-service";
import { transitionCampaignLifecycle } from "@/server/campaigns/campaign-lifecycle-service";
import { getCampaign } from "@/server/campaigns/campaign-service";
import { seedCampaignsData } from "@/server/campaigns/seed-campaigns-data";
import { seedDiscoveryData } from "@/server/discovery/seed-discovery-data";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { seedVendorsData } from "@/server/vendors/seed-vendors-data";
import { createAssignment, editAssignmentBrief, getAssignment } from "./assignment-service";
import { transitionAssignmentLifecycle } from "./assignment-lifecycle-service";
import { createExternalSubmissionSession, resolveExternalSubmission, revokeExternalSubmissionSession, submitExternalLinks } from "./external-submission-service";
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

async function createAssignedAssignment(head: ActorContext, partnerRef = "seed-partner-direct"): Promise<AssignmentDto> {
  const createdCampaign = await createCampaign(
    head,
    { name: uniqueName("Submission Test Campaign"), objective: "x", platforms: ["instagram", "youtube"], startDate: "2026-01-01", endDate: "2026-06-01", regionIds: ["Kerala"], defaultReviewPolicy: "REVIEW_REQUIRED" },
    "req",
  );
  if (!createdCampaign.ok) throw new Error("unreachable");
  const planned = await transitionCampaignLifecycle(head, createdCampaign.data.campaignRef, { to: "PLANNED", expectedVersion: createdCampaign.data.version }, "req");
  if (!planned.ok) throw new Error("unreachable");

  const created = await createAssignment(head, { campaignRef: createdCampaign.data.campaignRef, partnerRef, brief: { platforms: ["instagram", "youtube"] } }, "req");
  if (!created.ok) throw new Error("unreachable");
  const assigned = await transitionAssignmentLifecycle(head, created.data.assignmentRef, { to: "ASSIGNED", expectedVersion: created.data.version }, "req");
  if (!assigned.ok) throw new Error("unreachable");
  const refetched = await getAssignment(head, created.data.assignmentRef);
  if (!refetched.ok) throw new Error("unreachable");
  return refetched.data;
}

describe("Token security", () => {
  it("a strong token is created, returned only once, and only its hash is persisted (the SafeSessionDto never carries tokenHash or the raw token)", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    expect(typeof created.data.rawToken).toBe("string");
    expect(created.data.rawToken.length).toBeGreaterThan(20);
    const dtoJson = JSON.stringify(created.data.session);
    expect(dtoJson).not.toContain("tokenHash");
    expect(dtoJson).not.toContain(created.data.rawToken);
  });

  it("the created token resolves successfully via the public resolve path", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");
    const resolved = await resolveExternalSubmission(created.data.rawToken);
    expect(resolved.ok).toBe(true);
  });

  it("an invalid/made-up token returns a generic failure, never a distinguishable reason", async () => {
    const resolved = await resolveExternalSubmission("not-a-real-token-at-all");
    expect(resolved.ok).toBe(false);
  });

  it("a malformed (empty) token returns a generic failure", async () => {
    const resolved = await resolveExternalSubmission("");
    expect(resolved.ok).toBe(false);
  });
});

describe("Recipient rules", () => {
  it("a PARTNER session is always bound to the Assignment's own partnerRef - a mismatched recipientRef is rejected", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head, "seed-partner-direct");
    const result = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER", recipientRef: "creator-house" }, "req");
    expect(result.ok).toBe(false);
  });

  it("a VENDOR session succeeds only for the Partner's current active Vendor (creator-house / seed-vendor-agency)", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head, "creator-house");
    const result = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "VENDOR", recipientRef: "seed-vendor-agency" }, "req");
    expect(result.ok).toBe(true);
  });

  it("a VENDOR session is rejected for an unrelated Vendor (never the Partner's active Vendor)", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head, "creator-house");
    const result = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "VENDOR", recipientRef: "seed-vendor-manager" }, "req");
    expect(result.ok).toBe(false);
  });

  it("a seeded former-Vendor token (issued to a Vendor that is not the Partner's current active Vendor) fails at resolve time, same as a real Vendor switch would produce", async () => {
    const resolved = await resolveExternalSubmission("seed-submission-token-former-vendor");
    expect(resolved.ok).toBe(false);
  });

  it("the real active-Vendor seeded session (seed-vendor-agency for creator-house) resolves successfully", async () => {
    const resolved = await resolveExternalSubmission("seed-submission-token-vendor-active");
    expect(resolved.ok).toBe(true);
  });
});

// Step 10A.1 section 3: explicit certification of the exact Assignment
// states a submission session may be created/used against - ASSIGNED,
// ACCEPTED, IN_PROGRESS only, never DRAFT/COMPLETED/CANCELLED. Enforced
// by ASSIGNMENT_STATES_ACCEPTING_SUBMISSION in external-submission-service.ts,
// checked both at session creation (createExternalSubmissionSession) and
// at every public access/use (loadValidSession, called by both
// resolveExternalSubmission and submitExternalLinks). COMPLETED is
// structurally unreachable in this build (transitionAssignmentLifecycle
// always fails it closed - see assignment-lifecycle-service.ts), so no
// COMPLETED-specific test is possible or needed here.
describe("Session lifecycle state certification (ASSIGNED/ACCEPTED/IN_PROGRESS only)", () => {
  it("session creation is rejected while the Assignment is DRAFT", async () => {
    const head = await actorFor("partnership_head");
    const createdCampaign = await createCampaign(
      head,
      { name: uniqueName("Draft State Test"), objective: "x", platforms: ["instagram"], startDate: "2026-01-01", endDate: "2026-06-01", regionIds: ["Kerala"], defaultReviewPolicy: "REVIEW_REQUIRED" },
      "req",
    );
    if (!createdCampaign.ok) throw new Error("unreachable");
    await transitionCampaignLifecycle(head, createdCampaign.data.campaignRef, { to: "PLANNED", expectedVersion: createdCampaign.data.version }, "req");
    const draftAssignment = await createAssignment(head, { campaignRef: createdCampaign.data.campaignRef, partnerRef: "seed-partner-direct" }, "req");
    if (!draftAssignment.ok) throw new Error("unreachable");
    expect(draftAssignment.data.status).toBe("DRAFT");

    const result = await createExternalSubmissionSession(head, draftAssignment.data.assignmentRef, { recipientType: "PARTNER" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/DRAFT/);
  });

  it("session creation succeeds for each of ASSIGNED, ACCEPTED, and IN_PROGRESS", async () => {
    const head = await actorFor("partnership_head");
    const forwardPath = ["ASSIGNED", "ACCEPTED", "IN_PROGRESS"] as const;

    for (let target = 0; target < forwardPath.length; target += 1) {
      const createdCampaign = await createCampaign(
        head,
        { name: uniqueName("Accepting States Test"), objective: "x", platforms: ["instagram"], startDate: "2026-01-01", endDate: "2026-06-01", regionIds: ["Kerala"], defaultReviewPolicy: "REVIEW_REQUIRED" },
        "req",
      );
      if (!createdCampaign.ok) throw new Error("unreachable");
      await transitionCampaignLifecycle(head, createdCampaign.data.campaignRef, { to: "PLANNED", expectedVersion: createdCampaign.data.version }, "req");

      const created = await createAssignment(head, { campaignRef: createdCampaign.data.campaignRef, partnerRef: "seed-partner-direct" }, "req");
      if (!created.ok) throw new Error("unreachable");
      let version = created.data.version;
      const assignmentRef = created.data.assignmentRef;
      for (let step = 0; step <= target; step += 1) {
        const transitioned = await transitionAssignmentLifecycle(head, assignmentRef, { to: forwardPath[step]!, expectedVersion: version }, "req");
        if (!transitioned.ok) throw new Error("unreachable");
        version = transitioned.data.version;
      }

      const session = await createExternalSubmissionSession(head, assignmentRef, { recipientType: "PARTNER" }, "req");
      expect(session.ok).toBe(true);
    }
  });

  it("session creation is rejected once the Assignment is CANCELLED", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const cancelled = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", reason: "No evidence yet.", expectedVersion: assignment.version }, "req");
    expect(cancelled.ok).toBe(true);

    const result = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/CANCELLED/);
  });

  it("no scheduled cleanup job is required for correctness - a session created while valid becomes unusable purely from the live Assignment status re-check at request time", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");
    expect((await resolveExternalSubmission(session.data.rawToken)).ok).toBe(true);

    await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", reason: "Immediate invalidation check.", expectedVersion: assignment.version }, "req");

    // No job, no delay, no retry loop - the very next request already
    // sees it as unusable.
    expect((await resolveExternalSubmission(session.data.rawToken)).ok).toBe(false);
  });
});

describe("Public DTO / privacy", () => {
  it("only the safe allowlisted brief fields are ever returned - no internal ids, scope, actor, Finance, or history", async () => {
    const resolved = await resolveExternalSubmission("seed-submission-token-partner-active");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    const dto = resolved.data;
    expect(Object.keys(dto).sort()).toEqual(
      ["allowedPlatforms", "assignmentDisplayContext", "campaignName", "dueAt", "formats", "hashtags", "instructions", "language", "resourceLinks", "reviewPolicyNote"].sort(),
    );
    const json = JSON.stringify(dto).toLowerCase();
    // Deliberately not a bare "uid" check - "guidelines" (a legitimate
    // seeded resource-link label) contains that substring innocently.
    for (const forbidden of ["useruid", "owneruid", "scope", "restricted", "finance", "agreement", "token", "history"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  // Step 10A.1 section 4: seed-assignment-in-progress's own brief (see
  // seed-assignments-data.ts) deliberately carries one shareExternally:
  // true link and one shareExternally:false link, proving the split with
  // real fixture data rather than only a unit-level schema assertion.
  it("only shareExternally:true resource links reach the public DTO - internal-only links never leak, and the flag itself never appears", async () => {
    const resolved = await resolveExternalSubmission("seed-submission-token-partner-active");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");

    const labels = resolved.data.resourceLinks.map((l) => l.label);
    expect(labels).toContain("Public brand guidelines");
    expect(labels).not.toContain("Internal negotiation notes");

    for (const link of resolved.data.resourceLinks) {
      expect(Object.keys(link).sort()).toEqual(["label", "url"]);
    }
  });

  it("a resourceLink with no shareExternally value at all defaults to non-shareable (fail closed)", async () => {
    const head = await actorFor("partnership_head");
    // editAssignmentBrief only permits edits while DRAFT - build one
    // directly rather than via createAssignedAssignment (which already
    // advances to ASSIGNED).
    const createdCampaign = await createCampaign(
      head,
      { name: uniqueName("Fail-Closed Default Test"), objective: "x", platforms: ["instagram"], startDate: "2026-01-01", endDate: "2026-06-01", regionIds: ["Kerala"], defaultReviewPolicy: "REVIEW_REQUIRED" },
      "req",
    );
    if (!createdCampaign.ok) throw new Error("unreachable");
    await transitionCampaignLifecycle(head, createdCampaign.data.campaignRef, { to: "PLANNED", expectedVersion: createdCampaign.data.version }, "req");
    const draft = await createAssignment(head, { campaignRef: createdCampaign.data.campaignRef, partnerRef: "seed-partner-direct" }, "req");
    if (!draft.ok) throw new Error("unreachable");

    const edited = await editAssignmentBrief(
      head,
      draft.data.assignmentRef,
      { resourceLinks: [{ label: "No flag supplied", url: "https://example.com/unspecified.pdf" }], expectedVersion: draft.data.version },
      "req",
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error("unreachable");
    expect(edited.data.brief.resourceLinks[0]?.shareExternally).toBe(false);

    const withAssigned = await transitionAssignmentLifecycle(head, draft.data.assignmentRef, { to: "ASSIGNED", expectedVersion: edited.data.version }, "req");
    if (!withAssigned.ok) throw new Error("unreachable");
    const session = await createExternalSubmissionSession(head, draft.data.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");
    const resolved = await resolveExternalSubmission(session.data.rawToken);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.data.resourceLinks).toHaveLength(0);
  });
});

describe("Submission validation", () => {
  it("requires at least 1 row", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");
    const result = await submitExternalLinks(created.data.rawToken, []);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("invalid");
  });

  it("rejects more than the bounded max (10) rows", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");
    const rows = Array.from({ length: 11 }, (_, i) => ({ platform: "instagram", url: `https://instagram.com/p/${i}` }));
    const result = await submitExternalLinks(created.data.rawToken, rows);
    expect(result.ok).toBe(false);
  });

  it("normalizes platform casing/whitespace before validating against the Assignment's allowed platforms", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");
    const result = await submitExternalLinks(created.data.rawToken, [{ platform: "  Instagram  ", url: "https://instagram.com/p/x" }]);
    expect(result.ok).toBe(true);
  });

  it("rejects a platform not permitted by the Assignment", async () => {
    const head = await actorFor("partnership_head");
    const createdCampaign = await createCampaign(
      head,
      { name: uniqueName("X"), objective: "x", platforms: ["instagram"], startDate: "2026-01-01", endDate: "2026-06-01", regionIds: ["Kerala"], defaultReviewPolicy: "REVIEW_REQUIRED" },
      "req",
    );
    if (!createdCampaign.ok) throw new Error("unreachable");
    await transitionCampaignLifecycle(head, createdCampaign.data.campaignRef, { to: "PLANNED", expectedVersion: createdCampaign.data.version }, "req");
    const created = await createAssignment(head, { campaignRef: createdCampaign.data.campaignRef, partnerRef: "seed-partner-direct", brief: { platforms: ["instagram"] } }, "req");
    if (!created.ok) throw new Error("unreachable");
    await transitionAssignmentLifecycle(head, created.data.assignmentRef, { to: "ASSIGNED", expectedVersion: created.data.version }, "req");
    const session = await createExternalSubmissionSession(head, created.data.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");

    const result = await submitExternalLinks(session.data.rawToken, [{ platform: "youtube", url: "https://youtube.com/watch?v=x" }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/permitted/i);
  });

  it("rejects a non-https URL", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");
    const result = await submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: "http://instagram.com/p/x" }]);
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate platform+URL rows in the same submission", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");
    const row = { platform: "instagram", url: "https://instagram.com/p/x" };
    const result = await submitExternalLinks(created.data.rawToken, [row, row]);
    expect(result.ok).toBe(false);
  });

  it("a validation error does NOT consume the token - the session can still be used afterward", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");

    const invalid = await submitExternalLinks(created.data.rawToken, []);
    expect(invalid.ok).toBe(false);

    const stillResolvable = await resolveExternalSubmission(created.data.rawToken);
    expect(stillResolvable.ok).toBe(true);

    const validSubmit = await submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: "https://instagram.com/p/ok" }]);
    expect(validSubmit.ok).toBe(true);
  });
});

describe("Expiry / revocation / single-use", () => {
  it("an active token works end to end", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");
    const result = await submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: "https://instagram.com/p/x" }]);
    expect(result.ok).toBe(true);
  });

  it("an expired-by-time seeded token fails, enforced from the stored timestamp at request time (no scheduled job)", async () => {
    const resolved = await resolveExternalSubmission("seed-submission-token-expired");
    expect(resolved.ok).toBe(false);
    const submitted = await submitExternalLinks("seed-submission-token-expired", [{ platform: "instagram", url: "https://instagram.com/p/x" }]);
    expect(submitted.ok).toBe(false);
  });

  it("a revoked seeded token fails", async () => {
    const resolved = await resolveExternalSubmission("seed-submission-token-revoked");
    expect(resolved.ok).toBe(false);
  });

  it("revoking an active session makes it immediately unusable", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");

    const revoked = await revokeExternalSubmissionSession(head, assignment.assignmentRef, created.data.session.sessionRef, "req");
    expect(revoked.ok).toBe(true);

    const resolved = await resolveExternalSubmission(created.data.rawToken);
    expect(resolved.ok).toBe(false);
  });

  it("revoking an already-revoked/used session is a safe conflict, not a crash", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");
    await revokeExternalSubmissionSession(head, assignment.assignmentRef, created.data.session.sessionRef, "req");
    const again = await revokeExternalSubmissionSession(head, assignment.assignmentRef, created.data.session.sessionRef, "req");
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.code).toBe("conflict");
  });

  it("an Assignment moved to CANCELLED invalidates an otherwise-still-ACTIVE session", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");

    const cancelled = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", reason: "Test cancellation.", expectedVersion: assignment.version }, "req");
    expect(cancelled.ok).toBe(true);

    const resolved = await resolveExternalSubmission(created.data.rawToken);
    expect(resolved.ok).toBe(false);
  });

  it("successful submission consumes the token - a second submission with the same token fails safely", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");

    const first = await submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: "https://instagram.com/p/first" }]);
    expect(first.ok).toBe(true);

    const second = await submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: "https://instagram.com/p/second" }]);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe("unusable");
  });

  it("regeneration (create-new) never reactivates a revoked/used token", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const first = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!first.ok) throw new Error("unreachable");
    await revokeExternalSubmissionSession(head, assignment.assignmentRef, first.data.session.sessionRef, "req");

    const second = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.data.rawToken).not.toBe(first.data.rawToken);

    const firstStillDead = await resolveExternalSubmission(first.data.rawToken);
    expect(firstStillDead.ok).toBe(false);
    const secondWorks = await resolveExternalSubmission(second.data.rawToken);
    expect(secondWorks.ok).toBe(true);
  });

  it(
    "concurrent double-submit on the same session: exactly one wins, the rest are safely unusable (repeated to build confidence)",
    async () => {
      const head = await actorFor("partnership_head");
      for (let round = 0; round < 5; round += 1) {
        const assignment = await createAssignedAssignment(head);
        const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
        if (!created.ok) throw new Error("unreachable");

        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) => submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: `https://instagram.com/p/${round}-${i}` }])),
        );
        const winners = results.filter((r) => r.ok);
        expect(winners).toHaveLength(1);
        const losers = results.filter((r) => !r.ok);
        expect(losers.every((r) => !r.ok && r.code === "unusable")).toBe(true);
      }
    },
    40_000,
  );
});

describe("Ownership boundaries", () => {
  it("a successful external submission never mutates the owning Campaign", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const before = await getCampaign(head, assignment.campaignRef);
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error("unreachable");

    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");
    await submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: "https://instagram.com/p/x" }]);

    const after = await getCampaign(head, assignment.campaignRef);
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("unreachable");
    expect(after.data.version).toBe(before.data.version);
  });

  it("the created submission batch carries only the submitted rows and safe provenance - no Finance/Content field exists on it", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");
    const submitted = await submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: "https://instagram.com/p/x" }]);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw new Error("unreachable");
    expect(typeof submitted.data.submissionRef).toBe("string");
    const json = JSON.stringify(submitted.data).toLowerCase();
    for (const forbidden of ["agreement", "payable", "invoice", "payment", "amount"]) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe("Cancellation vs. external-submission irreversibility", () => {
  it("cancellation succeeds normally when no external submission evidence exists yet", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const cancelled = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", reason: "No evidence yet - still legal.", expectedVersion: assignment.version }, "req");
    expect(cancelled.ok).toBe(true);
  });

  it("cancellation is refused once at least one immutable external submission batch exists for the Assignment", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");
    const submitted = await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: "https://instagram.com/p/x" }]);
    expect(submitted.ok).toBe(true);

    const cancelled = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", reason: "Trying anyway.", expectedVersion: assignment.version }, "req");
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) throw new Error("unreachable");
    expect(cancelled.code).toBe("not_ready");
    expect(cancelled.blockers?.[0]?.code).toBe("EXTERNAL_EVIDENCE_EXISTS");
  });

  it("an active, still-unused submission session alone (no submitted evidence yet) does not block cancellation", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");

    const cancelled = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", reason: "Session issued but never used.", expectedVersion: assignment.version }, "req");
    expect(cancelled.ok).toBe(true);

    // The now-orphaned session becomes unusable too, since the
    // Assignment itself is no longer in an accepting state.
    const resolved = await resolveExternalSubmission(session.data.rawToken);
    expect(resolved.ok).toBe(false);
  });

  it(
    "a real submission racing a cancel attempt: whichever the transaction observes wins consistently - either the submission lands and cancellation is then blocked, or cancellation lands first and the submission is then rejected as non-accepting (repeated to build confidence)",
    async () => {
      const head = await actorFor("partnership_head");
      for (let round = 0; round < 5; round += 1) {
        const assignment = await createAssignedAssignment(head);
        const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
        if (!session.ok) throw new Error("unreachable");

        const [submitResult, cancelResult] = await Promise.all([
          submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: `https://instagram.com/p/race-${round}` }]),
          transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", reason: "Racing the submission.", expectedVersion: assignment.version }, "req"),
        ]);

        if (submitResult.ok) {
          // The submission won: exactly one immutable batch exists, and
          // cancellation must now be (or have been) blocked by it.
          expect(cancelResult.ok).toBe(false);
        } else {
          // Cancellation won (or raced ahead): the Assignment is no
          // longer accepting, so the submission is correctly rejected.
          expect(submitResult.code).toBe("unusable");
        }
      }
    },
    30_000,
  );
});
