// Step 10A section 19 (rewritten under Step 11A.1's business-process
// correction): a compact, deterministic Assignment + external-submission-
// session dataset covering every canonical Assignment lifecycle status,
// multiple Campaigns/Partners/scopes, same-Campaign-different-Partner and
// same-Partner-different-Campaign pairs, an active Partner session, an
// active Vendor session (against creator-house's real active Vendor,
// seed-vendor-agency - see seed-vendors-data.ts), a revoked session, an
// expired-by-time session, and a "former Vendor" session proving a stale
// token is invalid after a Vendor switch. Mirrors Campaigns'/Vendors' own
// seed-*-data.ts idiom exactly (fixed doc ids, full overwrite via
// .set(), safe synthetic values only, idempotent across repeated
// resets). Content threads themselves are seeded by seed-content-data.ts
// (run after this file - see emulator-reset.ts's own ordering), which is
// why every session below references a contentRef that file also seeds.
// "USED" sessions are retired (Step 11A.1: sessions are reusable across
// the whole revision loop, never single-use) - no fixture for that state
// exists anymore, and the old immutable assignmentExternalSubmissions
// batch fixture is retired too (that collection receives no new writes
// under the new model - see external-submission-service.ts's own
// comment).
import { createHash } from "node:crypto";

import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import { assignmentActiveClaimsCollection, assignmentSubmissionSessionsCollection, assignmentsCollection } from "./firestore";
import { getAdminAuth } from "@/server/firebase/admin";
import { getUserDoc } from "@/server/authz/firestore";
import type { AssignmentActiveClaimDoc, AssignmentDoc } from "./types";
import type { AssignmentSubmissionSessionDoc } from "./external-submission-types";

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
  // civic-voices are each reused across several different Partners
  // (proves "same Campaign, different Partners"); seed-partner-direct and
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
      // No submission has ever been made - hosts seed-content-open (Step
      // 11A.1's OPEN-thread fixture, see seed-content-data.ts) plus the
      // revoked and former-Vendor session fixtures below.
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
      // Hosts seed-content-under-review (a revision pending Manager
      // decision) plus the active-Vendor and expired-by-time session
      // fixtures below.
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
      // Hosts seed-content-revision-requested (a real revision loop: one
      // revision rejected-for-changes, page reopened) plus the reusable-
      // session proof fixture (seed-session-partner-active - the SAME
      // session/token that submitted revision 1 stays ACTIVE and would
      // reopen the same page).
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
      // Hosts seed-content-cancelled - a thread cancelled before any
      // submission (never reached OPEN's only real successor).
      ...assignmentBase("seed-assignment-cancelled", "civic-voices", "seed-partner-inactive"),
      status: "CANCELLED",
      statusReason: "Partner became unavailable before this obligation could proceed.",
      partnerAccountRefs: [],
      brief: { ...briefBase("Civic Voices", "Programme-wide plan for Civic Voices."), platforms: ["youtube"] },
      regionIds: [],
      teamIds: [],
      ownerUid: null,
    },
    // Step 11A.1: a single-canonical-thread fixture whose seeded status
    // is COMPLETED - the END STATE reached because its one and only
    // Content thread is itself APPROVED (see seed-content-data.ts's
    // matching seed-content-approved + thread-claim fixture). Seed data
    // is a static snapshot, never simulated live - the real behavioral
    // proof that approveContentThread's own transaction actually drives
    // an Assignment to COMPLETED is a live emulator test that creates a
    // fresh Assignment+Content pair and drives it through the real
    // service calls end to end; this fixture exists only as a read/
    // display snapshot.
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
    {
      // Hosts community-story-reel-01 - the EXPLICIT_RECORD scope fixture
      // partnership_head's own scope grant already depends on (see
      // seed-access-data.ts). A fresh, previously-unused
      // (civic-voices, seed-partner-archived) pair.
      ...assignmentBase("seed-assignment-community-story", "civic-voices", "seed-partner-archived"),
      status: "ASSIGNED",
      statusReason: null,
      partnerAccountRefs: [],
      brief: { ...briefBase("Civic Voices", "Programme-wide plan for Civic Voices."), platforms: ["instagram"] },
      regionIds: ["Punjab"],
      teamIds: [],
      ownerUid: null,
    },
    {
      // Hosts seed-content-collision-source - a fixed-identity thread a
      // live test can attempt to claim the same published URL against
      // from a DIFFERENT thread and assert conflict. A fresh, previously-
      // unused (seed-campaign-planned, seed-partner-inactive) pair.
      ...assignmentBase("seed-assignment-collision-source", "seed-campaign-planned", "seed-partner-inactive"),
      status: "ASSIGNED",
      statusReason: null,
      partnerAccountRefs: [],
      brief: { ...briefBase("South Programmes Launch", "Programme-wide plan for South Programmes Launch."), platforms: ["instagram"] },
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

  function sessionBase(
    recipientType: "PARTNER" | "VENDOR",
    assignment: AssignmentDoc,
    recipientRef: string,
    contentRef: string,
  ): Omit<AssignmentSubmissionSessionDoc, "tokenHash" | "sessionRef" | "state" | "expiresAt" | "lastSubmittedAt" | "revokedAt"> {
    return {
      assignmentRef: assignment.assignmentRef,
      campaignRef: assignment.campaignRef,
      partnerRef: assignment.partnerRef,
      recipientType,
      recipientRef,
      contentRef,
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
      // tests can exercise the public routes deterministically. Its
      // linked thread (seed-content-revision-requested) has already gone
      // through a full OPEN -> UNDER_REVIEW -> REVISION_REQUESTED cycle -
      // this is the reusable-session proof: the SAME session/token stays
      // ACTIVE and would reopen the SAME editable page.
      ...sessionBase("PARTNER", inProgress, inProgress.partnerRef, "seed-content-revision-requested"),
      tokenHash: hashToken("seed-submission-token-partner-active"),
      sessionRef: "seed-session-partner-active",
      state: "ACTIVE",
      expiresAt: futureIso,
      lastSubmittedAt: nowIso,
      revokedAt: null,
    },
    {
      // Active VENDOR session - creator-house's REAL current active
      // Vendor (seed-vendor-agency, see seed-vendors-data.ts) - proves a
      // legitimate Vendor session resolves successfully. Linked to
      // seed-content-under-review (a revision pending Manager decision).
      ...sessionBase("VENDOR", accepted, "seed-vendor-agency", "seed-content-under-review"),
      tokenHash: hashToken("seed-submission-token-vendor-active"),
      sessionRef: "seed-session-vendor-active",
      state: "ACTIVE",
      expiresAt: futureIso,
      lastSubmittedAt: nowIso,
      revokedAt: null,
    },
    {
      // Revoked - a staff member issued this, then revoked it before it
      // was ever used.
      ...sessionBase("PARTNER", assigned, assigned.partnerRef, "seed-content-open"),
      tokenHash: hashToken("seed-submission-token-revoked"),
      sessionRef: "seed-session-revoked",
      state: "REVOKED",
      expiresAt: futureIso,
      lastSubmittedAt: null,
      revokedAt: nowIso,
    },
    {
      // Expired-by-time - still formally ACTIVE, but its expiresAt is in
      // the past, proving expiry is enforced at request time from the
      // stored timestamp, never a separate scheduled job.
      ...sessionBase("PARTNER", accepted, accepted.partnerRef, "seed-content-under-review"),
      tokenHash: hashToken("seed-submission-token-expired"),
      sessionRef: "seed-session-expired",
      state: "ACTIVE",
      expiresAt: pastIso,
      lastSubmittedAt: null,
      revokedAt: null,
    },
    {
      // Former-Vendor case: recipientRef names a Vendor that is NOT
      // creator-house's current active Vendor (seed-vendor-manager has no
      // active link to creator-house at all) - proves a stale/former
      // Vendor token is correctly rejected at resolve/submit time, same
      // as an actual Vendor-switch would produce.
      ...sessionBase("VENDOR", assigned, "seed-vendor-manager", "seed-content-open"),
      tokenHash: hashToken("seed-submission-token-former-vendor"),
      sessionRef: "seed-session-former-vendor",
      state: "ACTIVE",
      expiresAt: futureIso,
      lastSubmittedAt: null,
      revokedAt: null,
    },
  ];

  for (const session of sessions) {
    await assignmentSubmissionSessionsCollection().doc(session.tokenHash).set(session);
  }
}
