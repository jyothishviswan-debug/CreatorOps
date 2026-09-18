// Step 11A.1: a compact, deterministic Content dataset covering every
// canonical thread status (OPEN, UNDER_REVIEW, REVISION_REQUESTED,
// APPROVED, CANCELLED - Step 11A/11B's two-policy production/review/
// publication model is retired entirely, see types.ts), the
// EXPLICIT_RECORD scope fixture partnership_head's own scope grant
// already depends on (community-story-reel-01), and a fixed-identity
// "collision source" thread (with its own pre-seeded publication claim
// doc, so a live test can attempt to claim the same identity against a
// DIFFERENT thread and assert conflict). Exactly ONE thread per
// Assignment (Step 11A.1's own core simplification) - see
// seed-assignments-data.ts (run BEFORE this file - see
// emulator-reset.ts's own ordering) for the Assignments each thread
// below belongs to. Mirrors Assignments'/Campaigns'/Partners' own
// seed-*-data.ts idiom exactly (fixed doc ids, full overwrite via
// .set(), safe synthetic values only, idempotent across repeated
// resets). No Finance dependencies anywhere.
//
// Written directly (not through resolveOrCreateContentThread/the
// lifecycle services) - same "static end-state snapshot, not a
// simulated live sequence" idiom every other seed-*-data.ts file
// already uses. The real behavioral proof that these services actually
// enforce the rules this snapshot merely displays lives in
// content.emulator.test.ts's own live service-call-driven tests.
import { getAdminAuth } from "@/server/firebase/admin";
import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import { getUserDoc } from "@/server/authz/firestore";
import { contentAssignmentThreadClaimsCollection, contentCollection, contentEventsCollection, contentPublicationClaimId, contentPublicationClaimsCollection, contentRevisionsCollection } from "./firestore";
import { normalizeContentUrl, publicationUrlIdentityKey } from "./publication-identity";
import type { ContentAssignmentThreadClaimDoc, ContentDoc, ContentEvent, ContentEventKind, ContentLinkRow, ContentPublicationClaimDoc, ContentRevisionDoc } from "./types";

async function uidFor(email: string): Promise<string> {
  const user = await getAdminAuth().getUserByEmail(email);
  return user.uid;
}

export async function seedContentData(): Promise<void> {
  if (!isUsingEmulators()) {
    throw new Error("seedContentData: refusing to run - Firebase emulator env vars are not set.");
  }
  const { projectId } = getServerEnv();
  if (!projectId.startsWith("demo-")) {
    throw new Error(`seedContentData: refusing to run - resolved project id "${projectId}" doesn't look like the local demo project.`);
  }

  const headDoc = await getUserDoc(await uidFor("head@creatorops.com"));
  if (!headDoc) throw new Error("seedContentData: head@creatorops.com has no users/{uid} document yet - run seedAccessControlData first.");
  const headUserRef = headDoc.userRef;
  const managerUid = await uidFor("manager@creatorops.com");

  const now = new Date();
  const nowIso = now.toISOString();

  function base(
    uid: string,
    assignmentRef: string,
    campaignRef: string,
    partnerRef: string,
  ): Pick<ContentDoc, "uid" | "contentRef" | "version" | "assignmentRef" | "campaignRef" | "partnerRef" | "openedAt" | "createdAt" | "createdByUserRef" | "updatedAt" | "updatedByUserRef"> {
    return {
      uid,
      contentRef: uid,
      version: 1,
      assignmentRef,
      campaignRef,
      partnerRef,
      openedAt: nowIso,
      createdAt: nowIso,
      createdByUserRef: headUserRef,
      updatedAt: nowIso,
      updatedByUserRef: headUserRef,
    };
  }

  function linkRow(platform: string, url: string): ContentLinkRow {
    return { platform, originalUrl: url, normalizedUrl: normalizeContentUrl(url), recordedAt: nowIso };
  }

  const contentDocs: ContentDoc[] = [
    {
      // OPEN - no submission has ever been made yet.
      ...base("seed-content-open", "seed-assignment-assigned", "civic-voices", "creator-house"),
      status: "OPEN",
      statusReason: null,
      currentRevisionNumber: 0,
      reviewedRevisionNumber: null,
      currentLinks: [],
      qualifyingFulfillment: null,
      dueAt: null,
      firstSubmittedAt: null,
      lastSubmittedAt: null,
      approvedAt: null,
      cancelledAt: null,
      ownerUid: null,
      regionIds: [],
      teamIds: [],
    },
    {
      // UNDER_REVIEW - revision 1 submitted, awaiting a Manager decision.
      ...base("seed-content-under-review", "seed-assignment-accepted", "seed-campaign-planned", "creator-house"),
      status: "UNDER_REVIEW",
      statusReason: null,
      currentRevisionNumber: 1,
      reviewedRevisionNumber: 1,
      currentLinks: [linkRow("instagram", "https://instagram.com/p/seed-under-review-1")],
      qualifyingFulfillment: null,
      dueAt: null,
      firstSubmittedAt: nowIso,
      lastSubmittedAt: nowIso,
      approvedAt: null,
      cancelledAt: null,
      ownerUid: managerUid,
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
    },
    {
      // REVISION_REQUESTED - revision 1 was rejected-for-changes with a
      // real reason; the same public page reopens for correction (see
      // seed-assignments-data.ts's seed-session-partner-active, linked to
      // this exact thread).
      ...base("seed-content-revision-requested", "seed-assignment-in-progress", "civic-voices", "seed-partner-direct"),
      status: "REVISION_REQUESTED",
      statusReason: "Please retake the intro shot in better lighting and re-submit.",
      currentRevisionNumber: 1,
      reviewedRevisionNumber: 1,
      currentLinks: [linkRow("youtube", "https://youtube.com/watch?v=seed-revision-requested-1")],
      qualifyingFulfillment: null,
      dueAt: null,
      firstSubmittedAt: nowIso,
      lastSubmittedAt: nowIso,
      approvedAt: null,
      cancelledAt: null,
      ownerUid: null,
      regionIds: [],
      teamIds: [],
    },
    {
      // CANCELLED - cancelled before any submission was ever made.
      ...base("seed-content-cancelled", "seed-assignment-cancelled", "civic-voices", "seed-partner-inactive"),
      status: "CANCELLED",
      statusReason: "Partner became unavailable before this obligation could proceed.",
      currentRevisionNumber: 0,
      reviewedRevisionNumber: null,
      currentLinks: [],
      qualifyingFulfillment: null,
      dueAt: null,
      firstSubmittedAt: null,
      lastSubmittedAt: null,
      approvedAt: null,
      cancelledAt: nowIso,
      ownerUid: null,
      regionIds: [],
      teamIds: [],
    },
    {
      // APPROVED - the "reaches COMPLETED" fulfillment-proof fixture.
      // Matches seed-assignment-content-fulfilled's own already-seeded
      // COMPLETED end-state (see seed-assignments-data.ts). A read/
      // display snapshot only - the real behavioral proof that
      // approveContentThread's own transaction is what drives this is a
      // live emulator test.
      ...base("seed-content-approved", "seed-assignment-content-fulfilled", "seed-campaign-planned", "seed-partner-archived"),
      status: "APPROVED",
      statusReason: null,
      currentRevisionNumber: 1,
      reviewedRevisionNumber: 1,
      currentLinks: [linkRow("instagram", "https://instagram.com/p/seed-approved-1")],
      qualifyingFulfillment: { kind: "QUALIFYING_REQUIRED", reasonCode: null, determinedAt: nowIso },
      dueAt: null,
      firstSubmittedAt: nowIso,
      lastSubmittedAt: nowIso,
      approvedAt: nowIso,
      cancelledAt: null,
      ownerUid: managerUid,
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
    },
    {
      // EXPLICIT_RECORD scope fixture - see seed-access-data.ts's
      // SCOPE_GRANTS.partnership_head own pre-existing
      // { type: "EXPLICIT_RECORD", resourceType: "content", resourceId: "community-story-reel-01" }
      // grant. regionIds/teamIds are deliberately Punjab/[] - outside
      // every one of Head's own REGION/TEAM grants (Kerala, Maharashtra,
      // Tamil Nadu, Karnataka, the rest of South/West Zone, kerala-
      // programmes, maharashtra-programmes) - so this record is reachable
      // ONLY through the explicit grant, proving it actually does the
      // work rather than region/team coincidentally covering it too.
      ...base("community-story-reel-01", "seed-assignment-community-story", "civic-voices", "seed-partner-archived"),
      status: "APPROVED",
      statusReason: null,
      currentRevisionNumber: 1,
      reviewedRevisionNumber: 1,
      currentLinks: [linkRow("instagram", "https://instagram.com/p/seed-community-story")],
      qualifyingFulfillment: { kind: "QUALIFYING_REQUIRED", reasonCode: null, determinedAt: nowIso },
      dueAt: null,
      firstSubmittedAt: nowIso,
      lastSubmittedAt: nowIso,
      approvedAt: nowIso,
      cancelledAt: null,
      ownerUid: null,
      regionIds: ["Punjab"],
      teamIds: [],
    },
    {
      // Fixed-identity "collision source" - a live test can attempt to
      // claim this exact URL against a DIFFERENT seeded thread and assert
      // `conflict`. Its own claim doc is seeded below, generic, driven by
      // this fixture's own currentLinks.
      ...base("seed-content-collision-source", "seed-assignment-collision-source", "seed-campaign-planned", "seed-partner-inactive"),
      status: "APPROVED",
      statusReason: null,
      currentRevisionNumber: 1,
      reviewedRevisionNumber: 1,
      currentLinks: [linkRow("instagram", "https://instagram.com/p/seed-content-collision")],
      qualifyingFulfillment: { kind: "QUALIFYING_REQUIRED", reasonCode: null, determinedAt: nowIso },
      dueAt: null,
      firstSubmittedAt: nowIso,
      lastSubmittedAt: nowIso,
      approvedAt: nowIso,
      cancelledAt: null,
      ownerUid: managerUid,
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
    },
  ];

  for (const doc of contentDocs) {
    await contentCollection().doc(doc.uid).set(doc);

    // The one-canonical-thread-per-Assignment claim - every seeded
    // thread's own lock (doc id = assignmentRef directly).
    const threadClaim: ContentAssignmentThreadClaimDoc = { assignmentRef: doc.assignmentRef, contentRef: doc.contentRef, contentUid: doc.uid, claimedAt: doc.createdAt };
    await contentAssignmentThreadClaimsCollection().doc(doc.assignmentRef).set(threadClaim);

    // Every current-link's own publication-identity claim - generic,
    // driven by whatever currentLinks each fixture actually carries
    // (this is what makes seed-content-collision-source's own fixed
    // identity actually "claimed" in storage).
    for (const link of doc.currentLinks) {
      const key = publicationUrlIdentityKey(link.platform, link.normalizedUrl);
      const urlClaim: ContentPublicationClaimDoc = { key, contentRef: doc.contentRef, contentUid: doc.uid, revisionNumber: doc.currentRevisionNumber, claimedAt: link.recordedAt };
      await contentPublicationClaimsCollection().doc(contentPublicationClaimId(key)).set(urlClaim);
    }

    // Revision 1's own immutable snapshot, for every fixture that has
    // ever had a link submitted.
    if (doc.currentRevisionNumber >= 1) {
      const revisionUid = contentRevisionsCollection(doc.uid).doc().id;
      const revisionDoc: ContentRevisionDoc = {
        uid: revisionUid,
        revisionNumber: 1,
        rows: doc.currentLinks.map((link) => ({ platform: link.platform, originalUrl: link.originalUrl, normalizedUrl: link.normalizedUrl })),
        recipientType: "PARTNER",
        recipientRef: doc.partnerRef,
        submittedAt: doc.firstSubmittedAt ?? doc.createdAt,
      };
      await contentRevisionsCollection(doc.uid).doc(revisionUid).set(revisionDoc);
    }
  }

  // Real event/audit history for every fixture - proves the append-only
  // history is populated consistently with each thread's own status.
  async function writeEvent(contentUid: string, kind: ContentEventKind, metadata: Record<string, unknown> | null): Promise<void> {
    const eventUid = contentEventsCollection(contentUid).doc().id;
    const event: ContentEvent = { kind, actorUserRef: headUserRef, metadata, requestId: "seed", createdAt: nowIso };
    await contentEventsCollection(contentUid).doc(eventUid).set(event);
  }

  await writeEvent("seed-content-open", "created", { assignmentRef: "seed-assignment-assigned" });

  await writeEvent("seed-content-under-review", "created", { assignmentRef: "seed-assignment-accepted" });
  await writeEvent("seed-content-under-review", "submitted", { revisionNumber: 1 });

  await writeEvent("seed-content-revision-requested", "created", { assignmentRef: "seed-assignment-in-progress" });
  await writeEvent("seed-content-revision-requested", "submitted", { revisionNumber: 1 });
  await writeEvent("seed-content-revision-requested", "revision_requested", {
    revisionNumber: 1,
    reason: "Please retake the intro shot in better lighting and re-submit.",
  });

  await writeEvent("seed-content-cancelled", "created", { assignmentRef: "seed-assignment-cancelled" });
  await writeEvent("seed-content-cancelled", "cancelled", { reason: "Partner became unavailable before this obligation could proceed." });

  await writeEvent("seed-content-approved", "created", { assignmentRef: "seed-assignment-content-fulfilled" });
  await writeEvent("seed-content-approved", "submitted", { revisionNumber: 1 });
  await writeEvent("seed-content-approved", "approved", { revisionNumber: 1 });

  await writeEvent("community-story-reel-01", "created", { assignmentRef: "seed-assignment-community-story" });
  await writeEvent("community-story-reel-01", "submitted", { revisionNumber: 1 });
  await writeEvent("community-story-reel-01", "approved", { revisionNumber: 1 });

  await writeEvent("seed-content-collision-source", "created", { assignmentRef: "seed-assignment-collision-source" });
  await writeEvent("seed-content-collision-source", "submitted", { revisionNumber: 1 });
  await writeEvent("seed-content-collision-source", "approved", { revisionNumber: 1 });
}
