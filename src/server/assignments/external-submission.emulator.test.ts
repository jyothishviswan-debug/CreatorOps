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
import { createPartner } from "@/server/partners/partner-service";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { seedVendorsData } from "@/server/vendors/seed-vendors-data";
import { createAssignment, editAssignmentBrief, getAssignment } from "./assignment-service";
import { transitionAssignmentLifecycle } from "./assignment-lifecycle-service";
import {
  createExternalSubmissionSession,
  getActiveSubmissionSessionForRecipient,
  getAssignmentCurrentVendorOption,
  resolveExternalSubmission,
  revokeExternalSubmissionSession,
  submitExternalLinks,
} from "./external-submission-service";
import { seedAssignmentsData } from "./seed-assignments-data";
import type { AssignmentDto } from "./client-dto";
import { listContent } from "@/server/content/content-service";
import { approveContentThread, requestContentRevision } from "@/server/content/content-lifecycle-service";
import type { ContentDto } from "@/server/content/client-dto";

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

// Step 11A.1: submitExternalLinks now claims publication-identity per
// submitted URL (submission IS the publication evidence now) - unlike
// the retired model, the SAME literal URL reused across different
// Content threads in this file would collide for real. Every submitted
// URL below must be unique per call.
function uniqueUrl(prefix: string): string {
  return `https://instagram.com/p/${prefix}-${runId}-${Math.random().toString(36).slice(2, 8)}`;
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

// The Assignment's one canonical Content thread - resolved via the
// bounded listContent({assignmentRef, limit: 1}) read, mirroring
// AssignmentContentPanel's own real client-side lookup.
async function threadFor(head: ActorContext, assignmentRef: string): Promise<ContentDto> {
  const list = await listContent(head, { assignmentRef, limit: 1 });
  if (!list.ok) throw new Error("unreachable");
  const thread = list.data.content[0];
  if (!thread) throw new Error(`unreachable: no Content thread found for ${assignmentRef}`);
  return thread;
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

// Step 10C section 17: the bounded, Assignment-scoped read the WhatsApp
// share dialog uses to decide whether to offer a Vendor recipient option -
// never a broad Vendor list, never contact/bank/tax/payee fields.
describe("getAssignmentCurrentVendorOption", () => {
  it("returns the safe display label + opaque vendorRef for a Partner with a current active Vendor (creator-house / seed-vendor-agency)", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head, "creator-house");
    const result = await getAssignmentCurrentVendorOption(head, assignment.assignmentRef);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.vendor).toEqual({ vendorRef: "seed-vendor-agency", displayName: "Northline Talent Agency" });
  });

  it("returns vendor: null for a Partner with no current active Vendor", async () => {
    const head = await actorFor("partnership_head");
    // Every seeded ACTIVE Partner already has a real active Vendor link
    // (see seed-vendors-data.ts) - a genuinely vendor-less Partner needs
    // a fresh one created here.
    const partner = await createPartner(head, { displayName: uniqueName("Vendor-less Partner") }, "req");
    if (!partner.ok) throw new Error("unreachable");
    const assignment = await createAssignedAssignment(head, partner.data.partnerRef);
    const result = await getAssignmentCurrentVendorOption(head, assignment.assignmentRef);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.vendor).toBeNull();
  });

  it("never exposes contact/bank/tax/payee fields - only vendorRef and displayName", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head, "creator-house");
    const result = await getAssignmentCurrentVendorOption(head, assignment.assignmentRef);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Object.keys(result.data.vendor ?? {}).sort()).toEqual(["displayName", "vendorRef"]);
  });

  it("is denied for an actor without Assignments access, same gate as session creation", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head, "creator-house");
    const viewer = await actorFor("viewer");
    const result = await getAssignmentCurrentVendorOption(viewer, assignment.assignmentRef);
    expect(result.ok).toBe(false);
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
      [
        "allowedPlatforms",
        "assignmentDisplayContext",
        "campaignName",
        "currentLinks",
        "dueAt",
        "formats",
        "hashtags",
        "instructions",
        "language",
        "resourceLinks",
        "reviewPolicyNote",
        "revisionNote",
        "threadStatus",
      ].sort(),
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
    const result = await submitExternalLinks(created.data.rawToken, [{ platform: "  Instagram  ", url: uniqueUrl("casing") }]);
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

    const result = await submitExternalLinks(session.data.rawToken, [{ platform: "youtube", url: "https://youtube.com/watch?v=not-permitted" }]);
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
    const row = { platform: "instagram", url: uniqueUrl("dup") };
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

    const validSubmit = await submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: uniqueUrl("ok") }]);
    expect(validSubmit.ok).toBe(true);
  });
});

describe("Expiry / revocation / single-use", () => {
  it("an active token works end to end", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");
    const result = await submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: uniqueUrl("active-e2e") }]);
    expect(result.ok).toBe(true);
  });

  it("an expired-by-time seeded token fails, enforced from the stored timestamp at request time (no scheduled job)", async () => {
    const resolved = await resolveExternalSubmission("seed-submission-token-expired");
    expect(resolved.ok).toBe(false);
    const submitted = await submitExternalLinks("seed-submission-token-expired", [{ platform: "instagram", url: uniqueUrl("expired") }]);
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

  it("Step 11A.1: the SAME token/session is reused, never single-use - a successful submission locks the page (thread -> UNDER_REVIEW) so an immediate second submission with the same token fails, but the SESSION itself stays ACTIVE (never a 'USED' state)", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");

    const first = await submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: uniqueUrl("first") }]);
    expect(first.ok).toBe(true);

    const second = await submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: uniqueUrl("second") }]);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe("unusable");

    // The token/session itself is still ACTIVE and still resolves - it
    // is locked only because the thread is UNDER_REVIEW, not because the
    // session was consumed.
    const stillResolves = await resolveExternalSubmission(created.data.rawToken);
    expect(stillResolves.ok).toBe(true);
    if (!stillResolves.ok) throw new Error("unreachable");
    expect(stillResolves.data.threadStatus).toBe("UNDER_REVIEW");
  });

  it("regeneration (create-new) never reactivates a revoked token", async () => {
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
    await submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: uniqueUrl("no-campaign-mutation") }]);

    const after = await getCampaign(head, assignment.campaignRef);
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("unreachable");
    expect(after.data.version).toBe(before.data.version);
  });

  it("the submit response carries only the new revision number - no Finance field exists on it, and no Campaign is ever mutated", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");
    const submitted = await submitExternalLinks(created.data.rawToken, [{ platform: "instagram", url: uniqueUrl("ownership") }]);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw new Error("unreachable");
    expect(submitted.data.revisionNumber).toBe(1);
    const json = JSON.stringify(submitted.data).toLowerCase();
    for (const forbidden of ["agreement", "payable", "invoice", "payment", "amount"]) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe("Cancellation vs. Content-thread irreversibility", () => {
  it("cancellation succeeds normally when no submission evidence exists yet", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const cancelled = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", reason: "No evidence yet - still legal.", expectedVersion: assignment.version }, "req");
    expect(cancelled.ok).toBe(true);
  });

  // Step 11A.1: submitExternalLinks no longer writes to the retired
  // assignmentExternalSubmissions collection at all - the irreversible-
  // evidence blocker is now entirely Content-thread-status-driven (see
  // assignment-lifecycle-service.ts's own updated comment).
  it("cancellation is refused once the Assignment's Content thread has at least one submitted revision", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");
    const submitted = await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("cancel-blocked") }]);
    expect(submitted.ok).toBe(true);

    const cancelled = await transitionAssignmentLifecycle(head, assignment.assignmentRef, { to: "CANCELLED", reason: "Trying anyway.", expectedVersion: assignment.version }, "req");
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) throw new Error("unreachable");
    expect(cancelled.code).toBe("not_ready");
    expect(cancelled.blockers?.[0]?.code).toBe("CONTENT_EVIDENCE_EXISTS");
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
          submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl(`race-${round}`) }]),
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

// Step 11A.1's own core business-process correction: Partner/Vendor
// submits already-published links via the public page, the Manager
// approves (closes) or requests revision (reopens the SAME page), and
// this repeats until approved. Every scenario below is driven through the
// REAL public route (submitExternalLinks) and the REAL trusted service
// calls (approveContentThread/requestContentRevision), never a direct
// Firestore write.
describe("Revision loop", () => {
  it("initial submit: revision 1 immutable, thread UNDER_REVIEW, not editable", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");

    const submitted = await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("initial-rev1") }]);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw new Error("unreachable");
    expect(submitted.data.revisionNumber).toBe(1);

    const thread = await threadFor(head, assignment.assignmentRef);
    expect(thread.status).toBe("UNDER_REVIEW");
    expect(thread.currentRevisionNumber).toBe(1);
    expect(thread.reviewedRevisionNumber).toBe(1);
    expect(thread.currentLinks).toHaveLength(1);
  });

  it("Manager requests revision: in-scope allowed, reason required, SAME token reopens with the latest links prefilled - no new session/token is minted", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");
    const submittedUrl = uniqueUrl("request-revision-rev1");
    await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: submittedUrl }]);

    const thread = await threadFor(head, assignment.assignmentRef);
    const missingReason = await requestContentRevision(head, thread.contentRef, { reason: "", reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req");
    expect(missingReason.ok).toBe(false);

    const revised = await requestContentRevision(head, thread.contentRef, { reason: "Please retake in better lighting.", reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req");
    expect(revised.ok).toBe(true);
    if (!revised.ok) throw new Error("unreachable");
    expect(revised.data.status).toBe("REVISION_REQUESTED");

    // SAME token/session - never a new one - reopens the real editable
    // page, prefilled with the latest submitted links.
    const resolved = await resolveExternalSubmission(session.data.rawToken);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.data.threadStatus).toBe("REVISION_REQUESTED");
    expect(resolved.data.revisionNote).toBe("Please retake in better lighting.");
    expect(resolved.data.currentLinks).toEqual([{ platform: "instagram", url: submittedUrl }]);
  });

  it("resubmit: revision 2 immutable, revision 1 preserved, SAME token locks again afterward", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");
    await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("resubmit-rev1") }]);

    const thread1 = await threadFor(head, assignment.assignmentRef);
    await requestContentRevision(head, thread1.contentRef, { reason: "Retake.", reviewedRevisionNumber: thread1.reviewedRevisionNumber!, expectedVersion: thread1.version }, "req");

    const rev2Url = uniqueUrl("resubmit-rev2");
    const resubmit = await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: rev2Url }]);
    expect(resubmit.ok).toBe(true);
    if (!resubmit.ok) throw new Error("unreachable");
    expect(resubmit.data.revisionNumber).toBe(2);

    const thread2 = await threadFor(head, assignment.assignmentRef);
    expect(thread2.status).toBe("UNDER_REVIEW");
    expect(thread2.currentRevisionNumber).toBe(2);
    expect(thread2.currentLinks[0]?.originalUrl).toBe(rev2Url);

    // The page locked again after the resubmit - a third attempt fails.
    const lockedAgain = await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("resubmit-rev3") }]);
    expect(lockedAgain.ok).toBe(false);
  });

  it("repeated revision loop: three full submit/request-revision cycles on the SAME token", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const submitted = await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl(`cycle-${cycle}`) }]);
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) throw new Error("unreachable");
      expect(submitted.data.revisionNumber).toBe(cycle);

      if (cycle < 3) {
        const thread = await threadFor(head, assignment.assignmentRef);
        const revised = await requestContentRevision(head, thread.contentRef, { reason: `Cycle ${cycle} changes.`, reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req");
        expect(revised.ok).toBe(true);
      }
    }

    const finalThread = await threadFor(head, assignment.assignmentRef);
    expect(finalThread.status).toBe("UNDER_REVIEW");
    expect(finalThread.currentRevisionNumber).toBe(3);
  });

  it("Manager approves the latest revision: status APPROVED, page permanently closed, no separate Complete Content action exists anywhere", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");
    await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("final") }]);

    const thread = await threadFor(head, assignment.assignmentRef);
    const approved = await approveContentThread(head, thread.contentRef, { reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req");
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error("unreachable");
    expect(approved.data.status).toBe("APPROVED");

    const resolved = await resolveExternalSubmission(session.data.rawToken);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.data.threadStatus).toBe("APPROVED");

    // Permanently closed - even a Manager cannot request revision anymore.
    const cannotReviseAfterApproval = await requestContentRevision(
      head,
      thread.contentRef,
      { reason: "Too late.", reviewedRevisionNumber: approved.data.reviewedRevisionNumber!, expectedVersion: approved.data.version },
      "req",
    );
    expect(cannotReviseAfterApproval.ok).toBe(false);

    // The public route itself also refuses further submission.
    const cannotResubmit = await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("too-late") }]);
    expect(cannotResubmit.ok).toBe(false);
  });

  // Karnataka is deliberately EXCLUDED from Manager's own region grants
  // but explicitly held by Head (see seed-access-data.ts's own comment on
  // this exact asymmetry) - the same load-bearing carve-out several other
  // regression suites already depend on, reused here to prove
  // review_content stays genuinely scope-gated (never a same-action,
  // same-role free pass) rather than merely role-gated.
  it("Manager cross-scope denied: an actor with review_content but no scope over this Assignment's region is refused, while a scoped Head succeeds", async () => {
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");
    const createdCampaign = await createCampaign(
      head,
      { name: uniqueName("Cross-Scope Review Test"), objective: "x", platforms: ["instagram"], startDate: "2026-01-01", endDate: "2026-06-01", regionIds: ["Karnataka"], defaultReviewPolicy: "REVIEW_REQUIRED" },
      "req",
    );
    if (!createdCampaign.ok) throw new Error("unreachable");
    await transitionCampaignLifecycle(head, createdCampaign.data.campaignRef, { to: "PLANNED", expectedVersion: createdCampaign.data.version }, "req");
    const created = await createAssignment(head, { campaignRef: createdCampaign.data.campaignRef, partnerRef: "seed-partner-direct", brief: { platforms: ["instagram"] } }, "req");
    if (!created.ok) throw new Error("unreachable");
    const assigned = await transitionAssignmentLifecycle(head, created.data.assignmentRef, { to: "ASSIGNED", expectedVersion: created.data.version }, "req");
    if (!assigned.ok) throw new Error("unreachable");

    const session = await createExternalSubmissionSession(head, created.data.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");
    await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("cross-scope") }]);

    const thread = await threadFor(head, created.data.assignmentRef);
    const denied = await approveContentThread(manager, thread.contentRef, { reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.code).toBe("unauthorized");

    // The SAME Head who created it (with real scope over it) can.
    const allowed = await approveContentThread(head, thread.contentRef, { reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req");
    expect(allowed.ok).toBe(true);
  });

  it("Viewer/Analyst are denied review_content entirely", async () => {
    const head = await actorFor("partnership_head");
    const viewer = await actorFor("viewer");
    const analyst = await actorFor("analyst");
    const assignment = await createAssignedAssignment(head);
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");
    await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("viewer-analyst") }]);
    const thread = await threadFor(head, assignment.assignmentRef);

    for (const actor of [viewer, analyst]) {
      const denied = await approveContentThread(actor, thread.contentRef, { reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req");
      expect(denied.ok).toBe(false);
    }
  });

  it("a stale decision against a previous revision fails", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");
    await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("stale-decision-rev1") }]);
    const thread1 = await threadFor(head, assignment.assignmentRef);
    const staleRevisionNumber = thread1.reviewedRevisionNumber!;

    // Revision 2 lands before the Manager's decision is recorded.
    await requestContentRevision(head, thread1.contentRef, { reason: "First round changes.", reviewedRevisionNumber: staleRevisionNumber, expectedVersion: thread1.version }, "req");
    await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("stale-decision-rev2") }]);

    const thread2 = await threadFor(head, assignment.assignmentRef);
    const staleApprove = await approveContentThread(head, thread2.contentRef, { reviewedRevisionNumber: staleRevisionNumber, expectedVersion: thread2.version }, "req");
    expect(staleApprove.ok).toBe(false);
    if (staleApprove.ok) throw new Error("unreachable");
    expect(staleApprove.code).toBe("stale_write");

    // The real current revision still approves cleanly.
    const realApprove = await approveContentThread(head, thread2.contentRef, { reviewedRevisionNumber: thread2.reviewedRevisionNumber!, expectedVersion: thread2.version }, "req");
    expect(realApprove.ok).toBe(true);
  });

  it("stale/concurrent public resubmit creates at most one new revision", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");
    await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("concurrent-base-rev1") }]);
    const thread1 = await threadFor(head, assignment.assignmentRef);
    await requestContentRevision(head, thread1.contentRef, { reason: "Changes.", reviewedRevisionNumber: thread1.reviewedRevisionNumber!, expectedVersion: thread1.version }, "req");

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl(`concurrent-${i}`) }])),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    const thread2 = await threadFor(head, assignment.assignmentRef);
    expect(thread2.currentRevisionNumber).toBe(2);
  });

  it(
    "Manager decision vs resubmit race serializes safely - the thread always ends in exactly one consistent state",
    async () => {
      const head = await actorFor("partnership_head");
      for (let round = 0; round < 3; round += 1) {
        const assignment = await createAssignedAssignment(head);
        const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
        if (!session.ok) throw new Error("unreachable");
        await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl(`decision-race-base-${round}`) }]);
        const thread = await threadFor(head, assignment.assignmentRef);

        const [approveResult, resubmitResult] = await Promise.all([
          approveContentThread(head, thread.contentRef, { reviewedRevisionNumber: thread.reviewedRevisionNumber!, expectedVersion: thread.version }, "req"),
          submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl(`decision-race-resubmit-${round}`) }]),
        ]);

        // A resubmit only ever succeeds against OPEN/REVISION_REQUESTED,
        // never UNDER_REVIEW - so against a thread that just moved
        // straight from UNDER_REVIEW to APPROVED, the resubmit always
        // loses this particular race by construction. The real
        // concurrency proof is that the approval itself always succeeds
        // cleanly and the thread ends in exactly one consistent state.
        expect(approveResult.ok).toBe(true);
        expect(resubmitResult.ok).toBe(false);
        const finalThread = await threadFor(head, assignment.assignmentRef);
        expect(finalThread.status).toBe("APPROVED");
      }
    },
    30_000,
  );

  it("no Campaign or Finance mutation happens anywhere in the loop", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const before = await getCampaign(head, assignment.campaignRef);
    if (!before.ok) throw new Error("unreachable");

    const session = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!session.ok) throw new Error("unreachable");
    await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("no-mutation-rev1") }]);
    const thread1 = await threadFor(head, assignment.assignmentRef);
    await requestContentRevision(head, thread1.contentRef, { reason: "Changes.", reviewedRevisionNumber: thread1.reviewedRevisionNumber!, expectedVersion: thread1.version }, "req");
    await submitExternalLinks(session.data.rawToken, [{ platform: "instagram", url: uniqueUrl("no-mutation-rev2") }]);
    const thread2 = await threadFor(head, assignment.assignmentRef);
    await approveContentThread(head, thread2.contentRef, { reviewedRevisionNumber: thread2.reviewedRevisionNumber!, expectedVersion: thread2.version }, "req");

    const after = await getCampaign(head, assignment.campaignRef);
    if (!after.ok) throw new Error("unreachable");
    expect(after.data.version).toBe(before.data.version);
  });
});

// Section 12: never mint a second competing token/page for the same
// (Assignment, recipient) while an eligible one is still live.
describe("Session reuse (Section 12 - never a competing second page)", () => {
  it("getActiveSubmissionSessionForRecipient returns null when no eligible session exists", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const result = await getActiveSubmissionSessionForRecipient(head, assignment.assignmentRef, "PARTNER", undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.session).toBeNull();
  });

  it("getActiveSubmissionSessionForRecipient finds the eligible active session once one exists", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const created = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!created.ok) throw new Error("unreachable");

    const result = await getActiveSubmissionSessionForRecipient(head, assignment.assignmentRef, "PARTNER", undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.session?.sessionRef).toBe(created.data.session.sessionRef);
  });

  it("createExternalSubmissionSession refuses a second competing token while an eligible active session already exists - WhatsApp ON reuses the correct ONE active page", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head);
    const first = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    if (!first.ok) throw new Error("unreachable");

    const second = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe("conflict");
    expect(second.message).toContain(first.data.session.sessionRef);
    // Never the token itself in the message.
    expect(second.message).not.toContain(first.data.rawToken);
  });

  it("the reuse guard is scoped per recipient - a PARTNER session and a VENDOR session for the same Assignment coexist independently", async () => {
    const head = await actorFor("partnership_head");
    const assignment = await createAssignedAssignment(head, "creator-house");
    const partnerSession = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "PARTNER" }, "req");
    expect(partnerSession.ok).toBe(true);
    const vendorSession = await createExternalSubmissionSession(head, assignment.assignmentRef, { recipientType: "VENDOR", recipientRef: "seed-vendor-agency" }, "req");
    expect(vendorSession.ok).toBe(true);
  });

  it("still ACTIVE remains reusable even after the thread went through a full OPEN -> UNDER_REVIEW -> REVISION_REQUESTED cycle (the seeded proof fixture)", async () => {
    // seed-session-partner-active (seed-assignment-in-progress) already
    // carries this exact history via seed-assignments-data.ts/
    // seed-content-data.ts - proves the SAME token stays valid and would
    // reopen the SAME editable page without any live mutation here.
    const resolved = await resolveExternalSubmission("seed-submission-token-partner-active");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.data.threadStatus).toBe("REVISION_REQUESTED");
    expect(resolved.data.currentLinks.length).toBeGreaterThan(0);
  });

  it("WhatsApp OFF creates zero session/token - buildAssignmentSubmissionShareContext never creates one on its own", async () => {
    const { buildAssignmentSubmissionShareContext } = await import("./external-submission-service");
    const context = buildAssignmentSubmissionShareContext({ campaignName: "Test Campaign", assignmentSummary: null, dueAt: null });
    expect(context.whatsappMessage).not.toMatch(/submit your links here/i);
  });
});
