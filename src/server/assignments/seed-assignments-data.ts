// Step 10A section 19: a compact, deterministic Assignment + external-
// submission-session dataset covering every canonical lifecycle status,
// multiple Campaigns/Partners/scopes, same-Campaign-different-Partner and
// same-Partner-different-Campaign pairs, an active Partner session, an
// active Vendor session (against creator-house's real active Vendor,
// seed-vendor-agency - see seed-vendors-data.ts), a used session, a
// revoked session, an expired-by-time session, a "former Vendor" session
// proving a stale token is invalid after a Vendor switch, and one
// immutable external submission batch. Mirrors Campaigns'/Vendors' own
// seed-*-data.ts idiom exactly (fixed doc ids, full overwrite via .set(),
// safe synthetic values only, idempotent across repeated resets). Does
// NOT seed Content/Finance/Payables/Invoices/Payments (none exist yet).
import { createHash } from "node:crypto";

import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import {
  assignmentActiveClaimsCollection,
  assignmentExternalSubmissionsCollection,
  assignmentSubmissionSessionsCollection,
  assignmentsCollection,
} from "./firestore";
import { getAdminAuth } from "@/server/firebase/admin";
import { getUserDoc } from "@/server/authz/firestore";
import type { AssignmentActiveClaimDoc, AssignmentDoc } from "./types";
import type { AssignmentExternalSubmissionDoc, AssignmentSubmissionSessionDoc } from "./external-submission-types";

async function uidFor(email: string): Promise<string> {
  const user = await getAdminAuth().getUserByEmail(email);
  return user.uid;
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export async function seedAssignmentsData(): Promise<void> {
  if (!isUsingEmulators()) {
    throw new Error("seedAssignmentsData: refusing to run - Firebase emulator env vars are not set.");
  }
  const { projectId } = getServerEnv();
  if (!projectId.startsWith("demo-")) {
    throw new Error(`seedAssignmentsData: refusing to run - resolved project id "${projectId}" doesn't look like the local demo project.`);
  }

  const headDoc = await getUserDoc(await uidFor("head@creatorops.com"));
  if (!headDoc) throw new Error("seedAssignmentsData: head@creatorops.com has no users/{uid} document yet - run seedAccessControlData first.");
  const headUserRef = headDoc.userRef;
  const managerUid = await uidFor("manager@creatorops.com");
  const managerDoc = await getUserDoc(managerUid);
  const managerUserRef = managerDoc!.userRef;

  const now = new Date();
  const nowIso = now.toISOString();
  const pastIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const futureIso = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  function briefBase(campaignName: string, campaignObjective: string) {
    return {
      instructions: "Post an authentic day-in-the-life reel featuring the product.",
      contentRequirementSummary: "One reel + one static carousel.",
      requiredCount: 2,
      formats: ["reel", "carousel"],
      language: "English",
      hashtags: ["#partner", "#brandpartnership"],
      dueAt: futureIso.slice(0, 10),
      // One shareable (public-safe) and one internal-only link, so tests
      // can prove the split (Step 10A.1 section 4) - fail-closed default,
      // never automatically public.
      resourceLinks: [
        { label: "Public brand guidelines", url: "https://example.com/brand-brief.pdf", shareExternally: true },
        { label: "Internal negotiation notes", url: "https://example.com/internal-notes.pdf", shareExternally: false },
      ],
      reviewPolicy: "REVIEW_REQUIRED" as const,
      campaignName,
      campaignObjective,
    };
  }

  function assignmentBase(uid: string, campaignRef: string, partnerRef: string): Omit<AssignmentDoc, "status" | "statusReason" | "brief" | "regionIds" | "teamIds" | "ownerUid" | "partnerAccountRefs"> {
    return {
      uid,
      assignmentRef: uid,
      version: 1,
      campaignRef,
      partnerRef,
      createdAt: nowIso,
      createdByUserRef: headUserRef,
      updatedAt: nowIso,
      updatedByUserRef: headUserRef,
    };
  }

  // Pairs (campaignRef, partnerRef) - each used at most once, per Step
  // 10A's own uniqueness invariant. seed-campaign-planned and
  // civic-voices are each reused across two different Partners (proves
  // "same Campaign, different Partners"); seed-partner-direct and
  // creator-house are each reused across two different Campaigns (proves
  // "same Partner, different Campaigns") - the same cross-pairing idiom
  // Campaigns' own seed data already established for scope proofs.
  const assignments: AssignmentDoc[] = [
    {
      ...assignmentBase("seed-assignment-draft", "seed-campaign-planned", "seed-partner-direct"),
      status: "DRAFT",
      statusReason: null,
      partnerAccountRefs: [],
      brief: { ...briefBase("South Programmes Launch", "Programme-wide plan for South Programmes Launch."), platforms: ["instagram"] },
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
      ownerUid: managerUid,
    },
    {
      ...assignmentBase("seed-assignment-assigned", "civic-voices", "creator-house"),
      status: "ASSIGNED",
      statusReason: null,
      partnerAccountRefs: [],
      brief: { ...briefBase("Civic Voices", "Programme-wide plan for Civic Voices."), platforms: ["youtube"] },
      regionIds: [],
      teamIds: [],
      ownerUid: null,
    },
    {
      ...assignmentBase("seed-assignment-accepted", "seed-campaign-planned", "creator-house"),
      status: "ACCEPTED",
      statusReason: null,
      partnerAccountRefs: [],
      brief: { ...briefBase("South Programmes Launch", "Programme-wide plan for South Programmes Launch."), platforms: ["instagram", "youtube"] },
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
      ownerUid: managerUid,
    },
    {
      ...assignmentBase("seed-assignment-in-progress", "civic-voices", "seed-partner-direct"),
      status: "IN_PROGRESS",
      statusReason: null,
      partnerAccountRefs: [],
      brief: { ...briefBase("Civic Voices", "Programme-wide plan for Civic Voices."), platforms: ["youtube"] },
      regionIds: [],
      teamIds: [],
      ownerUid: null,
    },
    {
      ...assignmentBase("seed-assignment-cancelled", "civic-voices", "seed-partner-inactive"),
      status: "CANCELLED",
      statusReason: "Partner became unavailable before this obligation could proceed.",
      partnerAccountRefs: [],
      brief: { ...briefBase("Civic Voices", "Programme-wide plan for Civic Voices."), platforms: ["youtube"] },
      regionIds: [],
      teamIds: [],
      ownerUid: null,
    },
    // Step 11A: a single-required-slot fixture whose seeded status is
    // COMPLETED - the END STATE reached because its one and only
    // required Content item is itself COMPLETED + QUALIFYING_REQUIRED
    // (see seed-content-data.ts's matching Content + CLAIMED slot claim
    // fixture). Seed data is a static snapshot, never simulated live -
    // the real behavioral proof that completeContent's own transaction
    // actually drives an Assignment to COMPLETED is a live emulator test
    // that creates a fresh Assignment+Content pair and drives it through
    // the real service calls end to end; this fixture exists only as a
    // read/display snapshot. (seed-campaign-planned, seed-partner-archived)
    // is a fresh, previously-unused pair - every other real ACTIVE
    // Partner is already paired with every eligible Campaign above.
    {
      ...assignmentBase("seed-assignment-content-fulfilled", "seed-campaign-planned", "seed-partner-archived"),
      status: "COMPLETED",
      statusReason: null,
      partnerAccountRefs: [],
      brief: { ...briefBase("South Programmes Launch", "Programme-wide plan for South Programmes Launch."), platforms: ["instagram"], formats: ["reel"], requiredCount: 1 },
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
      ownerUid: managerUid,
    },
  ];

  for (const assignment of assignments) {
    await assignmentsCollection().doc(assignment.uid).set(assignment);
    const claim: AssignmentActiveClaimDoc = { campaignRef: assignment.campaignRef, partnerRef: assignment.partnerRef, assignmentRef: assignment.assignmentRef, assignmentUid: assignment.uid, claimedAt: nowIso };
    await assignmentActiveClaimsCollection()
      .doc(`${assignment.campaignRef}:${assignment.partnerRef}`)
      .set(claim);
  }

  function sessionBase(recipientType: "PARTNER" | "VENDOR", assignment: AssignmentDoc, recipientRef: string): Omit<AssignmentSubmissionSessionDoc, "tokenHash" | "sessionRef" | "state" | "expiresAt" | "consumedAt" | "revokedAt"> {
    return {
      assignmentRef: assignment.assignmentRef,
      campaignRef: assignment.campaignRef,
      partnerRef: assignment.partnerRef,
      recipientType,
      recipientRef,
      createdAt: nowIso,
      createdByUserRef: managerUserRef,
      briefVersion: assignment.version,
      allowedPlatforms: assignment.brief.platforms,
      version: 1,
    };
  }

  const inProgress = assignments.find((a) => a.uid === "seed-assignment-in-progress")!;
  const accepted = assignments.find((a) => a.uid === "seed-assignment-accepted")!;
  const assigned = assignments.find((a) => a.uid === "seed-assignment-assigned")!;

  const sessions: AssignmentSubmissionSessionDoc[] = [
    {
      // Active PARTNER session - fixed known raw token so emulator/e2e
      // tests can exercise the public routes deterministically.
      ...sessionBase("PARTNER", inProgress, inProgress.partnerRef),
      tokenHash: hashToken("seed-submission-token-partner-active"),
      sessionRef: "seed-session-partner-active",
      state: "ACTIVE",
      expiresAt: futureIso,
      consumedAt: null,
      revokedAt: null,
    },
    {
      // Active VENDOR session - creator-house's REAL current active
      // Vendor (seed-vendor-agency, see seed-vendors-data.ts) - proves a
      // legitimate Vendor session resolves successfully.
      ...sessionBase("VENDOR", accepted, "seed-vendor-agency"),
      tokenHash: hashToken("seed-submission-token-vendor-active"),
      sessionRef: "seed-session-vendor-active",
      state: "ACTIVE",
      expiresAt: futureIso,
      consumedAt: null,
      revokedAt: null,
    },
    {
      // Used - already consumed by the one immutable submission batch
      // below.
      ...sessionBase("PARTNER", assigned, assigned.partnerRef),
      tokenHash: hashToken("seed-submission-token-used"),
      sessionRef: "seed-session-used",
      state: "USED",
      expiresAt: futureIso,
      consumedAt: nowIso,
      revokedAt: null,
    },
    {
      // Revoked - a staff member issued this, then revoked it before it
      // was ever used.
      ...sessionBase("PARTNER", inProgress, inProgress.partnerRef),
      tokenHash: hashToken("seed-submission-token-revoked"),
      sessionRef: "seed-session-revoked",
      state: "REVOKED",
      expiresAt: futureIso,
      consumedAt: null,
      revokedAt: nowIso,
    },
    {
      // Expired-by-time - still formally ACTIVE, but its expiresAt is in
      // the past, proving expiry is enforced at request time from the
      // stored timestamp, never a separate scheduled job.
      ...sessionBase("PARTNER", accepted, accepted.partnerRef),
      tokenHash: hashToken("seed-submission-token-expired"),
      sessionRef: "seed-session-expired",
      state: "ACTIVE",
      expiresAt: pastIso,
      consumedAt: null,
      revokedAt: null,
    },
    {
      // Former-Vendor case: recipientRef names a Vendor that is NOT
      // creator-house's current active Vendor (seed-vendor-manager has no
      // active link to creator-house at all) - proves a stale/former
      // Vendor token is correctly rejected at resolve/submit time, same
      // as an actual Vendor-switch would produce.
      ...sessionBase("VENDOR", assigned, "seed-vendor-manager"),
      tokenHash: hashToken("seed-submission-token-former-vendor"),
      sessionRef: "seed-session-former-vendor",
      state: "ACTIVE",
      expiresAt: futureIso,
      consumedAt: null,
      revokedAt: null,
    },
  ];

  for (const session of sessions) {
    await assignmentSubmissionSessionsCollection().doc(session.tokenHash).set(session);
  }

  const usedSession = sessions.find((s) => s.sessionRef === "seed-session-used")!;
  const submission: AssignmentExternalSubmissionDoc = {
    uid: "seed-submission-1",
    submissionRef: "seed-submission-1",
    sessionRef: usedSession.tokenHash,
    assignmentRef: usedSession.assignmentRef,
    campaignRef: usedSession.campaignRef,
    partnerRef: usedSession.partnerRef,
    recipientType: usedSession.recipientType,
    recipientRef: usedSession.recipientRef,
    rows: [{ platform: "youtube", url: "https://youtube.com/watch?v=seed-demo-1" }],
    submittedAt: nowIso,
  };
  await assignmentExternalSubmissionsCollection().doc(submission.uid).set(submission);
}
