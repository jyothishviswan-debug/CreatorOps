// Step 11A section 19: a compact, deterministic Content dataset covering
// every canonical status in BOTH review-policy lifecycle graphs, the
// EXPLICIT_RECORD scope fixture partnership_head's own scope grant
// already depends on (community-story-reel-01), a multi-evidence
// record, a fixed-identity "collision source" record (with its own
// pre-seeded publication claim docs, so a live test can attempt to
// claim the same identity against a DIFFERENT Content and assert
// conflict), and the two fulfillment-proof fixtures (a "stays blocked"
// partially-fulfilled Assignment and a "reaches COMPLETED" fully-
// fulfilled one). Mirrors Assignments'/Campaigns'/Partners' own
// seed-*-data.ts idiom exactly (fixed doc ids, full overwrite via
// .set(), safe synthetic values only, idempotent across repeated
// resets). No Finance dependencies anywhere.
//
// Written directly (not through generateContentFromAssignment/the
// lifecycle services) - same "static end-state snapshot, not a
// simulated live sequence" idiom every other seed-*-data.ts file
// already uses. The real behavioral proof that these services actually
// enforce the rules this snapshot merely displays lives in
// content.emulator.test.ts's own live service-call-driven tests.
import { getAdminAuth } from "@/server/firebase/admin";
import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import { getUserDoc } from "@/server/authz/firestore";
import {
  contentCollection,
  contentEventsCollection,
  contentPublicationClaimId,
  contentPublicationClaimsCollection,
  contentRequiredSlotClaimDocId,
  contentRequiredSlotClaimsCollection,
  contentVersionsCollection,
} from "./firestore";
import { normalizeContentUrl, publicationContentIdIdentityKey, publicationUrlIdentityKey } from "./publication-identity";
import type {
  ContentDoc,
  ContentEvent,
  ContentEventKind,
  ContentPublicationClaimDoc,
  ContentRequiredSlotClaimDoc,
  ContentVersionDoc,
  PublicationEvidenceItem,
} from "./types";

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

  function base(uid: string, assignmentRef: string, campaignRef: string, partnerRef: string): Pick<
    ContentDoc,
    "uid" | "contentRef" | "version" | "assignmentRef" | "campaignRef" | "partnerRef" | "createdAt" | "createdByUserRef" | "updatedAt" | "updatedByUserRef"
  > {
    return {
      uid,
      contentRef: uid,
      version: 1,
      assignmentRef,
      campaignRef,
      partnerRef,
      createdAt: nowIso,
      createdByUserRef: headUserRef,
      updatedAt: nowIso,
      updatedByUserRef: headUserRef,
    };
  }

  function evidenceItem(evidenceId: string, platform: string, url: string, platformContentId: string | null = null): PublicationEvidenceItem {
    return {
      evidenceId,
      platform,
      originalUrl: url,
      normalizedUrl: normalizeContentUrl(url),
      platformContentId,
      partnerAccountRef: null,
      publishedAt: null,
      recordedAt: nowIso,
      recordedByUserRef: headUserRef,
      provenance: "STAFF_RECORDED",
      sourceExternalSubmissionRef: null,
    };
  }

  // ---- REVIEW_REQUIRED: every canonical status --------------------------
  const reviewRequired: ContentDoc[] = [
    {
      ...base("seed-content-planned-review-required", "seed-assignment-draft", "seed-campaign-planned", "seed-partner-direct"),
      partnerAccountRef: null,
      platform: "instagram",
      contentType: "reel",
      title: "South Programmes launch reel",
      status: "PLANNED",
      statusReason: null,
      reviewPolicy: "REVIEW_REQUIRED",
      currentVersion: 0,
      lastSubmittedVersion: null,
      publicationEvidence: [],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: null,
      submittedAt: null,
      approvedAt: null,
      postedAt: null,
      completedAt: null,
      cancelledAt: null,
      ownerUid: managerUid,
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
    },
    {
      ...base("seed-content-in-production-review-required", "seed-assignment-assigned", "civic-voices", "creator-house"),
      partnerAccountRef: "seed-account-creatorhouse-yt",
      platform: "youtube",
      contentType: "video",
      title: null,
      status: "IN_PRODUCTION",
      statusReason: null,
      reviewPolicy: "REVIEW_REQUIRED",
      currentVersion: 1,
      lastSubmittedVersion: null,
      publicationEvidence: [],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: null,
      approvedAt: null,
      postedAt: null,
      completedAt: null,
      cancelledAt: null,
      ownerUid: null,
      regionIds: [],
      teamIds: [],
    },
    {
      ...base("seed-content-submitted-review-required", "seed-assignment-accepted", "seed-campaign-planned", "creator-house"),
      partnerAccountRef: "seed-account-creatorhouse-ig-primary",
      platform: "instagram",
      contentType: "carousel",
      title: "Launch carousel",
      status: "SUBMITTED",
      statusReason: null,
      reviewPolicy: "REVIEW_REQUIRED",
      currentVersion: 1,
      lastSubmittedVersion: 1,
      publicationEvidence: [],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: nowIso,
      approvedAt: null,
      postedAt: null,
      completedAt: null,
      cancelledAt: null,
      ownerUid: managerUid,
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
    },
    {
      // Two real versions + a real "review_decision" (CHANGES_REQUIRED)
      // event in its own history - see seedContentData's own event/
      // version writes below.
      ...base("seed-content-changes-requested", "seed-assignment-accepted", "seed-campaign-planned", "creator-house"),
      partnerAccountRef: null,
      platform: "instagram",
      contentType: "reel",
      title: "Revision-loop reel",
      status: "CHANGES_REQUIRED",
      statusReason: "Please retake the intro shot in better lighting and re-submit.",
      reviewPolicy: "REVIEW_REQUIRED",
      currentVersion: 2,
      lastSubmittedVersion: 1,
      publicationEvidence: [],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: nowIso,
      approvedAt: null,
      postedAt: null,
      completedAt: null,
      cancelledAt: null,
      ownerUid: managerUid,
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
    },
    {
      ...base("seed-content-approved-review-required", "seed-assignment-assigned", "civic-voices", "creator-house"),
      partnerAccountRef: null,
      platform: "youtube",
      contentType: "video",
      title: null,
      status: "APPROVED",
      statusReason: null,
      reviewPolicy: "REVIEW_REQUIRED",
      currentVersion: 1,
      lastSubmittedVersion: 1,
      publicationEvidence: [],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: nowIso,
      approvedAt: nowIso,
      postedAt: null,
      completedAt: null,
      cancelledAt: null,
      ownerUid: null,
      regionIds: [],
      teamIds: [],
    },
    {
      ...base("seed-content-rejected-review-required", "seed-assignment-assigned", "civic-voices", "creator-house"),
      partnerAccountRef: null,
      platform: "youtube",
      contentType: "video",
      title: null,
      status: "REJECTED",
      statusReason: "Does not meet brand guidelines - off-brief messaging.",
      reviewPolicy: "REVIEW_REQUIRED",
      currentVersion: 1,
      lastSubmittedVersion: 1,
      publicationEvidence: [],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: nowIso,
      approvedAt: null,
      postedAt: null,
      completedAt: null,
      cancelledAt: null,
      ownerUid: null,
      regionIds: [],
      teamIds: [],
    },
    {
      // Multi-evidence fixture - 2 distinct publication URLs on one
      // record.
      ...base("seed-content-posted-multi-evidence", "seed-assignment-accepted", "seed-campaign-planned", "creator-house"),
      partnerAccountRef: "seed-account-creatorhouse-ig-primary",
      platform: "instagram",
      contentType: "carousel",
      title: "Multi-post launch carousel",
      status: "POSTED",
      statusReason: null,
      reviewPolicy: "REVIEW_REQUIRED",
      currentVersion: 1,
      lastSubmittedVersion: 1,
      publicationEvidence: [
        evidenceItem("seed-evidence-multi-1", "instagram", "https://instagram.com/p/seed-multi-evidence-one"),
        evidenceItem("seed-evidence-multi-2", "instagram", "https://instagram.com/p/seed-multi-evidence-two"),
      ],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: nowIso,
      approvedAt: nowIso,
      postedAt: nowIso,
      completedAt: null,
      cancelledAt: null,
      ownerUid: managerUid,
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
    },
    {
      ...base("seed-content-completed-review-required", "seed-assignment-assigned", "civic-voices", "creator-house"),
      partnerAccountRef: null,
      platform: "youtube",
      contentType: "video",
      title: null,
      status: "COMPLETED",
      statusReason: null,
      reviewPolicy: "REVIEW_REQUIRED",
      currentVersion: 1,
      lastSubmittedVersion: 1,
      publicationEvidence: [evidenceItem("seed-evidence-completed-1", "youtube", "https://youtube.com/watch?v=seed-content-completed")],
      qualifyingFulfillment: { kind: "QUALIFYING_EXTRA", reasonCode: null, determinedAt: nowIso },
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: nowIso,
      approvedAt: nowIso,
      postedAt: nowIso,
      completedAt: nowIso,
      cancelledAt: null,
      ownerUid: null,
      regionIds: [],
      teamIds: [],
    },
    {
      ...base("seed-content-cancelled-review-required", "seed-assignment-cancelled", "civic-voices", "seed-partner-inactive"),
      partnerAccountRef: null,
      platform: "youtube",
      contentType: "video",
      title: null,
      status: "CANCELLED",
      statusReason: "Partner became unavailable before this obligation could proceed.",
      reviewPolicy: "REVIEW_REQUIRED",
      currentVersion: 0,
      lastSubmittedVersion: null,
      publicationEvidence: [],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: null,
      submittedAt: null,
      approvedAt: null,
      postedAt: null,
      completedAt: null,
      cancelledAt: nowIso,
      ownerUid: null,
      regionIds: [],
      teamIds: [],
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
      ...base("community-story-reel-01", "seed-assignment-assigned", "civic-voices", "creator-house"),
      partnerAccountRef: null,
      platform: "instagram",
      contentType: "reel",
      title: "Community story reel",
      status: "APPROVED",
      statusReason: null,
      reviewPolicy: "REVIEW_REQUIRED",
      currentVersion: 1,
      lastSubmittedVersion: 1,
      publicationEvidence: [],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: nowIso,
      approvedAt: nowIso,
      postedAt: null,
      completedAt: null,
      cancelledAt: null,
      ownerUid: null,
      regionIds: ["Punjab"],
      teamIds: [],
    },
    {
      // Fixed-identity "collision source" - a live test can attempt to
      // claim this exact URL/platformContentId against a DIFFERENT
      // seeded Content and assert `conflict`. Its own claim docs are
      // seeded below via seedPublicationClaims (generic, driven by every
      // fixture's own publicationEvidence array).
      ...base("seed-content-collision-source", "seed-assignment-accepted", "seed-campaign-planned", "creator-house"),
      partnerAccountRef: null,
      platform: "instagram",
      contentType: "reel",
      title: "Collision-identity source record",
      status: "POSTED",
      statusReason: null,
      reviewPolicy: "REVIEW_REQUIRED",
      currentVersion: 1,
      lastSubmittedVersion: 1,
      publicationEvidence: [evidenceItem("seed-evidence-collision-1", "instagram", "https://instagram.com/p/seed-content-collision", "seed-pcid-collision")],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: nowIso,
      approvedAt: nowIso,
      postedAt: nowIso,
      completedAt: null,
      cancelledAt: null,
      ownerUid: managerUid,
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
    },
  ];

  // ---- NO_PREPOST_REVIEW: every canonical status -------------------------
  const noPrepostReview: ContentDoc[] = [
    {
      ...base("seed-content-planned-no-review", "seed-assignment-draft", "seed-campaign-planned", "seed-partner-direct"),
      partnerAccountRef: null,
      platform: "instagram",
      contentType: "story",
      title: null,
      status: "PLANNED",
      statusReason: null,
      reviewPolicy: "NO_PREPOST_REVIEW",
      currentVersion: 0,
      lastSubmittedVersion: null,
      publicationEvidence: [],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: null,
      submittedAt: null,
      approvedAt: null,
      postedAt: null,
      completedAt: null,
      cancelledAt: null,
      ownerUid: managerUid,
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
    },
    {
      ...base("seed-content-in-production-no-review", "seed-assignment-accepted", "seed-campaign-planned", "creator-house"),
      partnerAccountRef: null,
      platform: "youtube",
      contentType: "video",
      title: null,
      status: "IN_PRODUCTION",
      statusReason: null,
      reviewPolicy: "NO_PREPOST_REVIEW",
      currentVersion: 1,
      lastSubmittedVersion: null,
      publicationEvidence: [],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: null,
      approvedAt: null,
      postedAt: null,
      completedAt: null,
      cancelledAt: null,
      ownerUid: managerUid,
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
    },
    {
      ...base("seed-content-posted-no-review", "seed-assignment-assigned", "civic-voices", "creator-house"),
      partnerAccountRef: null,
      platform: "youtube",
      contentType: "video",
      title: null,
      status: "POSTED",
      statusReason: null,
      reviewPolicy: "NO_PREPOST_REVIEW",
      currentVersion: 1,
      lastSubmittedVersion: null,
      publicationEvidence: [evidenceItem("seed-evidence-no-review-posted-1", "youtube", "https://youtube.com/watch?v=seed-no-review-posted")],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: null,
      approvedAt: null,
      postedAt: nowIso,
      completedAt: null,
      cancelledAt: null,
      ownerUid: null,
      regionIds: [],
      teamIds: [],
    },
    {
      ...base("seed-content-completed-no-review", "seed-assignment-assigned", "civic-voices", "creator-house"),
      partnerAccountRef: null,
      platform: "youtube",
      contentType: "video",
      title: null,
      status: "COMPLETED",
      statusReason: null,
      reviewPolicy: "NO_PREPOST_REVIEW",
      currentVersion: 1,
      lastSubmittedVersion: null,
      publicationEvidence: [evidenceItem("seed-evidence-no-review-completed-1", "youtube", "https://youtube.com/watch?v=seed-no-review-completed")],
      qualifyingFulfillment: { kind: "QUALIFYING_EXTRA", reasonCode: null, determinedAt: nowIso },
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: null,
      approvedAt: null,
      postedAt: nowIso,
      completedAt: nowIso,
      cancelledAt: null,
      ownerUid: null,
      regionIds: [],
      teamIds: [],
    },
    {
      ...base("seed-content-cancelled-no-review", "seed-assignment-draft", "seed-campaign-planned", "seed-partner-direct"),
      partnerAccountRef: null,
      platform: "instagram",
      contentType: "story",
      title: null,
      status: "CANCELLED",
      statusReason: "No longer needed for this obligation.",
      reviewPolicy: "NO_PREPOST_REVIEW",
      currentVersion: 0,
      lastSubmittedVersion: null,
      publicationEvidence: [],
      qualifyingFulfillment: null,
      requiredSlotIndex: null,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: null,
      submittedAt: null,
      approvedAt: null,
      postedAt: null,
      completedAt: null,
      cancelledAt: nowIso,
      ownerUid: managerUid,
      regionIds: ["Kerala", "Maharashtra"],
      teamIds: ["kerala-programmes", "maharashtra-programmes"],
    },
  ];

  // ---- Fulfillment proof pair --------------------------------------------
  // (a) "stays blocked": seed-assignment-in-progress (civic-voices/
  // seed-partner-direct, requiredCount 2) - slot 0 is COMPLETED +
  // QUALIFYING_REQUIRED, slot 1 is still IN_PRODUCTION (claimed, not
  // completed) - the Assignment must stay unfulfilled.
  const fulfillmentPartial: ContentDoc[] = [
    {
      ...base("seed-content-fulfillment-partial-slot0", "seed-assignment-in-progress", "civic-voices", "seed-partner-direct"),
      partnerAccountRef: null,
      platform: "youtube",
      contentType: "reel",
      title: null,
      status: "COMPLETED",
      statusReason: null,
      reviewPolicy: "REVIEW_REQUIRED",
      currentVersion: 1,
      lastSubmittedVersion: 1,
      publicationEvidence: [evidenceItem("seed-evidence-partial-slot0-1", "youtube", "https://youtube.com/watch?v=seed-partial-slot0")],
      qualifyingFulfillment: { kind: "QUALIFYING_REQUIRED", reasonCode: null, determinedAt: nowIso },
      requiredSlotIndex: 0,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: nowIso,
      approvedAt: nowIso,
      postedAt: nowIso,
      completedAt: nowIso,
      cancelledAt: null,
      ownerUid: null,
      regionIds: [],
      teamIds: [],
    },
    {
      ...base("seed-content-fulfillment-partial-slot1", "seed-assignment-in-progress", "civic-voices", "seed-partner-direct"),
      partnerAccountRef: null,
      platform: "youtube",
      contentType: "carousel",
      title: null,
      status: "IN_PRODUCTION",
      statusReason: null,
      reviewPolicy: "REVIEW_REQUIRED",
      currentVersion: 1,
      lastSubmittedVersion: null,
      publicationEvidence: [],
      qualifyingFulfillment: null,
      requiredSlotIndex: 1,
      supersedesContentRef: null,
      dueAt: null,
      productionStartedAt: nowIso,
      submittedAt: null,
      approvedAt: null,
      postedAt: null,
      completedAt: null,
      cancelledAt: null,
      ownerUid: null,
      regionIds: [],
      teamIds: [],
    },
  ];

  // (b) "reaches COMPLETED": seed-assignment-content-fulfilled
  // (requiredCount 1) - its one and only required slot is COMPLETED +
  // QUALIFYING_REQUIRED, matching the Assignment's own already-seeded
  // COMPLETED end-state (see seed-assignments-data.ts). A read/display
  // snapshot only - the real behavioral proof that completeContent's own
  // transaction is what drives this is a live emulator test.
  const fulfillmentComplete: ContentDoc = {
    ...base("seed-content-fulfillment-complete", "seed-assignment-content-fulfilled", "seed-campaign-planned", "seed-partner-archived"),
    partnerAccountRef: null,
    platform: "instagram",
    contentType: "reel",
    title: null,
    status: "COMPLETED",
    statusReason: null,
    reviewPolicy: "REVIEW_REQUIRED",
    currentVersion: 1,
    lastSubmittedVersion: 1,
    publicationEvidence: [evidenceItem("seed-evidence-fulfillment-complete-1", "instagram", "https://instagram.com/p/seed-fulfillment-complete")],
    qualifyingFulfillment: { kind: "QUALIFYING_REQUIRED", reasonCode: null, determinedAt: nowIso },
    requiredSlotIndex: 0,
    supersedesContentRef: null,
    dueAt: null,
    productionStartedAt: nowIso,
    submittedAt: nowIso,
    approvedAt: nowIso,
    postedAt: nowIso,
    completedAt: nowIso,
    cancelledAt: null,
    ownerUid: managerUid,
    regionIds: ["Kerala", "Maharashtra"],
    teamIds: ["kerala-programmes", "maharashtra-programmes"],
  };

  const allContent: ContentDoc[] = [...reviewRequired, ...noPrepostReview, ...fulfillmentPartial, fulfillmentComplete];

  for (const doc of allContent) {
    await contentCollection().doc(doc.uid).set(doc);

    // Every evidence item's own claim doc - generic, driven by whatever
    // publicationEvidence each fixture actually carries (this is what
    // makes seed-content-collision-source's own fixed identity actually
    // "claimed" in storage, and every other multi-evidence fixture
    // internally consistent).
    for (const evidence of doc.publicationEvidence) {
      const urlKey = publicationUrlIdentityKey(doc.platform, evidence.normalizedUrl);
      const urlClaim: ContentPublicationClaimDoc = { key: urlKey, contentRef: doc.contentRef, contentUid: doc.uid, evidenceId: evidence.evidenceId, claimedAt: evidence.recordedAt };
      await contentPublicationClaimsCollection().doc(contentPublicationClaimId(urlKey)).set(urlClaim);

      if (evidence.platformContentId) {
        const pcidKey = publicationContentIdIdentityKey(doc.platform, evidence.platformContentId);
        const pcidClaim: ContentPublicationClaimDoc = { key: pcidKey, contentRef: doc.contentRef, contentUid: doc.uid, evidenceId: evidence.evidenceId, claimedAt: evidence.recordedAt };
        await contentPublicationClaimsCollection().doc(contentPublicationClaimId(pcidKey)).set(pcidClaim);
      }
    }

    // Every required-obligation slot this fixture claims - CLAIMED (none
    // of these seed fixtures represent a released slot; the released-
    // slot/supersession case is proven live, in content.emulator.test.ts,
    // by actually cancelling a required Content and re-generating).
    if (doc.requiredSlotIndex !== null) {
      const claim: ContentRequiredSlotClaimDoc = {
        assignmentRef: doc.assignmentRef,
        slotIndex: doc.requiredSlotIndex,
        contentRef: doc.contentRef,
        contentUid: doc.uid,
        state: "CLAIMED",
        claimedAt: doc.createdAt,
        releasedAt: null,
      };
      await contentRequiredSlotClaimsCollection().doc(contentRequiredSlotClaimDocId(doc.assignmentRef, doc.requiredSlotIndex)).set(claim);
    }

    // Real immutable version docs, 1..currentVersion, for every fixture
    // that has ever had a version saved.
    for (let versionNumber = 1; versionNumber <= doc.currentVersion; versionNumber += 1) {
      const versionUid = contentVersionsCollection(doc.uid).doc().id;
      const versionDoc: ContentVersionDoc = {
        uid: versionUid,
        versionNumber,
        captionText: `Seed caption v${versionNumber} for ${doc.contentRef}.`,
        sourceUrl: null,
        submissionNotes: versionNumber === doc.currentVersion ? "Ready for review." : null,
        attachmentRefs: [],
        createdAt: doc.createdAt,
        createdByUserRef: doc.createdByUserRef,
      };
      await contentVersionsCollection(doc.uid).doc(versionUid).set(versionDoc);
    }
  }

  // The CHANGES_REQUIRED fixture's own real review_decision event -
  // proves history/audit trail for a resubmission-loop record.
  async function writeEvent(contentUid: string, kind: ContentEventKind, metadata: Record<string, unknown> | null): Promise<void> {
    const eventUid = contentEventsCollection(contentUid).doc().id;
    const event: ContentEvent = { kind, actorUserRef: headUserRef, metadata, requestId: "seed", createdAt: nowIso };
    await contentEventsCollection(contentUid).doc(eventUid).set(event);
  }

  await writeEvent("seed-content-changes-requested", "created", { assignmentRef: "seed-assignment-accepted" });
  await writeEvent("seed-content-changes-requested", "submitted", { version: 1 });
  await writeEvent("seed-content-changes-requested", "review_decision", {
    decision: "CHANGES_REQUIRED",
    version: 1,
    comment: "Please retake the intro shot in better lighting and re-submit.",
  });
  await writeEvent("seed-content-changes-requested", "version_saved", { versionNumber: 2 });
}
