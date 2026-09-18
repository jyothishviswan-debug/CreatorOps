// Step 12A section 19: a small, deterministic Analytics dataset covering
// every canonical matching scenario the task calls for - mirrors every
// other domain's seed-*-data.ts idiom exactly (fixed doc ids, full
// overwrite via .set(), safe synthetic values only, idempotent across
// repeated resets, written directly rather than through the live
// pipeline - the real behavioral proof that the services enforce these
// rules lives in analytics.emulator.test.ts's own live-call-driven
// tests).
//
// Reuses EXISTING seeded Content fixtures as real matching targets
// rather than inventing parallel ones:
//   - seed-content-approved's real currentLinks URL
//     (https://instagram.com/p/seed-approved-1) is the deterministic
//     MATCHED fixture below.
//   - seed-content-revision-requested's real currentLinks URL
//     (https://youtube.com/watch?v=seed-revision-requested-1) - a claim
//     genuinely exists for it, but that thread's status is
//     REVISION_REQUESTED, not APPROVED - the CONTENT_NOT_CURRENTLY_APPROVED
//     UNMATCHED fixture below.
//
// Honest limitation (documented here and in the Step 12A completion
// report): a genuine AMBIGUOUS *content* row could not be constructed
// under the current single-deterministic-claim-owner model (a normalized
// URL can only ever be claimed by exactly one Content thread, by
// construction - see content-matcher.ts's own header comment). No fake
// content-ambiguous fixture is seeded here. AMBIGUOUS is exercised for
// real below via Partner Account matching instead, which genuinely can
// produce it.
import { getAdminAuth } from "@/server/firebase/admin";
import { getServerEnv, isUsingEmulators } from "@/lib/env/server";
import { getUserDoc } from "@/server/authz/firestore";
import { normalizeContentUrl } from "@/server/content/publication-identity";
import { claimIdFor, computeNormalizedIdentity } from "@/server/partners/identity";
import { partnerAccountIdentityClaimsCollection, partnerAccountsCollection } from "@/server/partners/firestore";
import type { PartnerAccountDoc, PartnerAccountIdentityClaimDoc } from "@/server/partners/types";

import { analyticsChannelSourceRecordsCollection, analyticsContentSourceRecordsCollection, analyticsImportBatchesCollection, analyticsRowIdentityDocId } from "./firestore";
import { computeRowIdentityKey } from "./import-pipeline";
import type { AnalyticsChannelSourceRecordDoc, AnalyticsContentSourceRecordDoc, AnalyticsImportBatchDoc } from "./types";

async function uidFor(email: string): Promise<string> {
  const user = await getAdminAuth().getUserByEmail(email);
  return user.uid;
}

export async function seedAnalyticsData(): Promise<void> {
  if (!isUsingEmulators()) {
    throw new Error("seedAnalyticsData: refusing to run - Firebase emulator env vars are not set.");
  }
  const { projectId } = getServerEnv();
  if (!projectId.startsWith("demo-")) {
    throw new Error(`seedAnalyticsData: refusing to run - resolved project id "${projectId}" doesn't look like the local demo project.`);
  }

  const headDoc = await getUserDoc(await uidFor("head@creatorops.com"));
  if (!headDoc) throw new Error("seedAnalyticsData: head@creatorops.com has no users/{uid} document yet - run seedAccessControlData first.");
  const analystDoc = await getUserDoc(await uidFor("analyst@creatorops.com"));
  if (!analystDoc) throw new Error("seedAnalyticsData: analyst@creatorops.com has no users/{uid} document yet - run seedAccessControlData first.");
  const managerUid = await uidFor("manager@creatorops.com");
  const headUserRef = headDoc.userRef;
  const analystUserRef = analystDoc.userRef;

  const now = new Date().toISOString();

  // ---- Two extra Partner Account fixtures, deliberately seeded here
  // (not in seed-partners-data.ts) purely to exercise a genuine Partner
  // Account AMBIGUOUS match: both are keyed by their own STRONG evidence
  // (platformAccountId - so a handle-only fast-path lookup always misses
  // for both, exactly the gap the fallback scan exists to cover), but
  // both happen to also carry the exact same handle value - a real-world
  // data-quality collision (two different accounts, coincidentally
  // sharing a display handle), never a fabricated shortcut. One belongs
  // to "creator-house", the other to "seed-partner-inactive" - two
  // DIFFERENT Partners, so the ambiguity genuinely spans partners, not
  // just accounts under one.
  async function seedAmbiguousAccount(uid: string, partnerRef: string, platformAccountId: string): Promise<void> {
    const normalizedIdentity = computeNormalizedIdentity({ platform: "instagram", platformAccountId })!;
    const account: PartnerAccountDoc = {
      uid,
      partnerAccountRef: uid,
      version: 1,
      partnerRef,
      platform: "instagram",
      handle: "sharedhandle",
      displayName: "Shared Handle Fixture",
      profileUrl: `https://instagram.com/sharedhandle-${platformAccountId}`,
      platformAccountId,
      normalizedIdentity,
      primary: false,
      status: "ACTIVE",
      followerSnapshot: null,
      originAssetDecision: null,
      originLeadRef: null,
      createdAt: now,
      createdByUserRef: headUserRef,
      updatedAt: now,
      updatedByUserRef: headUserRef,
    };
    await partnerAccountsCollection().doc(uid).set(account);
    const claim: PartnerAccountIdentityClaimDoc = { normalizedIdentity, partnerAccountUid: uid, partnerAccountRef: uid, claimedAt: now };
    await partnerAccountIdentityClaimsCollection().doc(claimIdFor(normalizedIdentity)).set(claim);
  }

  await seedAmbiguousAccount("seed-account-analytics-ambiguous-a", "creator-house", "analytics-ambiguous-account-a");
  await seedAmbiguousAccount("seed-account-analytics-ambiguous-b", "seed-partner-inactive", "analytics-ambiguous-account-b");

  // ---- Import batches ------------------------------------------------
  function batchBase(uid: string, targetKind: AnalyticsImportBatchDoc["targetKind"], sourceFilename: string): AnalyticsImportBatchDoc {
    return {
      uid,
      batchRef: uid,
      targetKind,
      sourceFilename,
      sourceMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sourceExtension: "xlsx",
      sourceHash: `seed-hash-${uid}`,
      supersedesBatchRef: null,
      reportingPeriod: null,
      actorUserRef: analystUserRef,
      createdAt: now,
      startedAt: now,
      completedAt: now,
      status: "COMPLETED",
      totalRows: 0,
      actionableRows: 0,
      matchedRows: 0,
      unmatchedRows: 0,
      ambiguousRows: 0,
      invalidRows: 0,
      duplicateUnchangedRows: 0,
      failedRows: 0,
      sourceSheetInventory: [],
      safeErrorSummary: [],
    };
  }

  const contentBatch: AnalyticsImportBatchDoc = {
    ...batchBase("seed-analytics-batch-content-completed", "campaign_content", "instagram-and-youtube-content-export.xlsx"),
    totalRows: 3,
    actionableRows: 3,
    matchedRows: 1,
    unmatchedRows: 2,
    ambiguousRows: 0,
    sourceSheetInventory: [{ sheetName: "Content Export", rowCount: 3, recognizedAs: "campaign_content" }],
    safeErrorSummary: [],
  };
  await analyticsImportBatchesCollection().doc(contentBatch.uid).set(contentBatch);

  const channelBatch: AnalyticsImportBatchDoc = {
    ...batchBase("seed-analytics-batch-channel-completed", "channel_account", "instagram-channel-snapshot.xlsx"),
    totalRows: 3,
    actionableRows: 3,
    matchedRows: 1,
    unmatchedRows: 1,
    ambiguousRows: 1,
    sourceSheetInventory: [{ sheetName: "Channel Snapshot", rowCount: 3, recognizedAs: "channel_account" }],
    safeErrorSummary: [],
  };
  await analyticsImportBatchesCollection().doc(channelBatch.uid).set(channelBatch);

  // ---- Content source records -----------------------------------------
  function contentRecordBase(uid: string, batchRef: string, sourceRowNumber: number): Omit<
    AnalyticsContentSourceRecordDoc,
    | "rowIdentityKey"
    | "platform"
    | "rawPostUrl"
    | "normalizedUrl"
    | "matchState"
    | "matchEvidence"
    | "matchedContentRef"
    | "matchedAssignmentRef"
    | "matchedCampaignRef"
    | "matchedPartnerRef"
    | "matchedPartnerAccountRef"
    | "ownerUid"
    | "regionIds"
    | "teamIds"
  > {
    return {
      uid,
      sourceRef: uid,
      batchRef,
      sheetName: "Content Export",
      sourceRowNumber,
      rawPostId: null,
      rawPostType: "post",
      rawPostDateTime: now,
      rawMediaUrl: null,
      rawCaption: null,
      rawComments: "12",
      rawLikes: "340",
      rawViews: null,
      rawFollowers: null,
      rawUsername: null,
      rawEngagement: null,
      rawAccountOrChannelName: null,
      postDateTimeIso: now,
      comments: 12,
      likes: 340,
      views: null,
      profileFollowers: null,
      engagement: null,
      reportingPeriod: null,
      correctionRevision: 1,
      createdAt: now,
    };
  }

  // Doc id MUST equal the row's own hashed identity key (the same
  // invariant the live pipeline's own commitContentRow/commitChannelRow
  // maintain - see import-service.ts) - the record's own `uid` field is
  // set to that SAME hash here, never to the human-readable literal used
  // for `sourceRef` (the opaque, browser-facing handle). Getting this
  // wrong would silently break every uid-keyed lookup (correction-
  // service.ts, getAnalyticsContentSourceRecordByUid) against these seed
  // fixtures specifically.
  async function writeContentRecord(record: AnalyticsContentSourceRecordDoc): Promise<void> {
    const uid = analyticsRowIdentityDocId(record.rowIdentityKey);
    await analyticsContentSourceRecordsCollection().doc(uid).set({ ...record, uid });
  }
  async function writeChannelRecord(record: AnalyticsChannelSourceRecordDoc): Promise<void> {
    const uid = analyticsRowIdentityDocId(record.rowIdentityKey);
    await analyticsChannelSourceRecordsCollection().doc(uid).set({ ...record, uid });
  }

  const matchedUrl = "https://instagram.com/p/seed-approved-1";
  const matchedNormalizedUrl = normalizeContentUrl(matchedUrl);
  const matchedRecord: AnalyticsContentSourceRecordDoc = {
    ...contentRecordBase("seed-analytics-content-matched", contentBatch.batchRef, 2),
    platform: "instagram",
    rawPostUrl: matchedUrl,
    normalizedUrl: matchedNormalizedUrl,
    rowIdentityKey: computeRowIdentityKey("campaign_content", "instagram", `url:${matchedNormalizedUrl}`, null),
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: matchedNormalizedUrl, reasonCode: null, candidateCount: 1 },
    matchedContentRef: "seed-content-approved",
    matchedAssignmentRef: "seed-assignment-content-fulfilled",
    matchedCampaignRef: "seed-campaign-planned",
    matchedPartnerRef: "seed-partner-archived",
    matchedPartnerAccountRef: null,
    ownerUid: managerUid,
    regionIds: ["Kerala", "Maharashtra"],
    teamIds: ["kerala-programmes", "maharashtra-programmes"],
  };
  await writeContentRecord(matchedRecord);

  const unclaimedUrl = "https://instagram.com/p/seed-analytics-unclaimed-post";
  const unclaimedNormalizedUrl = normalizeContentUrl(unclaimedUrl);
  const unmatchedRecord: AnalyticsContentSourceRecordDoc = {
    ...contentRecordBase("seed-analytics-content-unmatched", contentBatch.batchRef, 3),
    platform: "instagram",
    rawPostUrl: unclaimedUrl,
    normalizedUrl: unclaimedNormalizedUrl,
    rowIdentityKey: computeRowIdentityKey("campaign_content", "instagram", `url:${unclaimedNormalizedUrl}`, null),
    matchState: "UNMATCHED",
    matchEvidence: { tier: "published_url", value: unclaimedNormalizedUrl, reasonCode: "NO_CLAIM_FOUND", candidateCount: 0 },
    matchedContentRef: null,
    matchedAssignmentRef: null,
    matchedCampaignRef: null,
    matchedPartnerRef: null,
    matchedPartnerAccountRef: null,
    ownerUid: null,
    regionIds: [],
    teamIds: [],
  };
  await writeContentRecord(unmatchedRecord);

  const notApprovedUrl = "https://youtube.com/watch?v=seed-revision-requested-1";
  const notApprovedNormalizedUrl = normalizeContentUrl(notApprovedUrl);
  const notCurrentlyApprovedRecord: AnalyticsContentSourceRecordDoc = {
    ...contentRecordBase("seed-analytics-content-not-approved", contentBatch.batchRef, 4),
    platform: "youtube",
    rawPostUrl: notApprovedUrl,
    normalizedUrl: notApprovedNormalizedUrl,
    rowIdentityKey: computeRowIdentityKey("campaign_content", "youtube", `url:${notApprovedNormalizedUrl}`, null),
    // A real claim exists for this exact URL (see seed-content-data.ts's
    // "seed-content-revision-requested") - but that thread's status is
    // REVISION_REQUESTED, not APPROVED, so this is deliberately
    // UNMATCHED with a DIFFERENT, more specific reasonCode than
    // "no claim found at all" - see content-matcher.ts.
    matchState: "UNMATCHED",
    matchEvidence: { tier: "published_url", value: notApprovedNormalizedUrl, reasonCode: "CONTENT_NOT_CURRENTLY_APPROVED", candidateCount: 1 },
    matchedContentRef: null,
    matchedAssignmentRef: null,
    matchedCampaignRef: null,
    matchedPartnerRef: null,
    matchedPartnerAccountRef: null,
    ownerUid: null,
    regionIds: [],
    teamIds: [],
  };
  await writeContentRecord(notCurrentlyApprovedRecord);

  // ---- Channel source records ------------------------------------------
  function channelRecordBase(uid: string, batchRef: string, sourceRowNumber: number): Omit<
    AnalyticsChannelSourceRecordDoc,
    "rowIdentityKey" | "platform" | "rawUsername" | "rawProfileUrl" | "rawPlatformAccountId" | "matchState" | "matchEvidence" | "matchedPartnerRef" | "matchedPartnerAccountRef" | "ownerUid" | "regionIds" | "teamIds"
  > {
    return {
      uid,
      sourceRef: uid,
      batchRef,
      sheetName: "Channel Snapshot",
      sourceRowNumber,
      rawFollowers: "128000",
      rawAccountOrChannelName: null,
      normalizedProfileUrl: null,
      profileFollowers: 128000,
      reportingPeriod: null,
      correctionRevision: 1,
      createdAt: now,
    };
  }

  const channelMatchedIdentity = computeNormalizedIdentity({ platform: "youtube", platformAccountId: "UCCreatorHouseSeedChannel" })!;
  const channelMatched: AnalyticsChannelSourceRecordDoc = {
    ...channelRecordBase("seed-analytics-channel-matched", channelBatch.batchRef, 2),
    platform: "youtube",
    rawUsername: null,
    rawProfileUrl: null,
    rawPlatformAccountId: "UCCreatorHouseSeedChannel",
    rowIdentityKey: computeRowIdentityKey("channel_account", "youtube", channelMatchedIdentity, null),
    matchState: "MATCHED",
    matchEvidence: { tier: "identity_claim", value: "UCCreatorHouseSeedChannel", reasonCode: null, candidateCount: 1 },
    matchedPartnerRef: "creator-house",
    matchedPartnerAccountRef: "seed-account-creatorhouse-yt",
    ownerUid: null,
    regionIds: ["Karnataka"],
    teamIds: [],
  };
  await writeChannelRecord(channelMatched);

  const channelAmbiguousIdentity = computeNormalizedIdentity({ platform: "instagram", handle: "sharedhandle" })!;
  const channelAmbiguous: AnalyticsChannelSourceRecordDoc = {
    ...channelRecordBase("seed-analytics-channel-ambiguous", channelBatch.batchRef, 3),
    platform: "instagram",
    rawUsername: "sharedhandle",
    rawProfileUrl: null,
    rawPlatformAccountId: null,
    rowIdentityKey: computeRowIdentityKey("channel_account", "instagram", channelAmbiguousIdentity, null),
    matchState: "AMBIGUOUS",
    matchEvidence: { tier: "bounded_scan", value: "sharedhandle", reasonCode: "MULTIPLE_DISTINCT_ACCOUNTS_MATCHED", candidateCount: 2 },
    matchedPartnerRef: null,
    matchedPartnerAccountRef: null,
    ownerUid: null,
    regionIds: [],
    teamIds: [],
  };
  await writeChannelRecord(channelAmbiguous);

  const channelUnmatchedIdentity = computeNormalizedIdentity({ platform: "tiktok", handle: "totally-unknown-handle" })!;
  const channelUnmatched: AnalyticsChannelSourceRecordDoc = {
    ...channelRecordBase("seed-analytics-channel-unmatched", channelBatch.batchRef, 4),
    platform: "tiktok",
    rawUsername: "totally-unknown-handle",
    rawProfileUrl: null,
    rawPlatformAccountId: null,
    rowIdentityKey: computeRowIdentityKey("channel_account", "tiktok", channelUnmatchedIdentity, null),
    matchState: "UNMATCHED",
    matchEvidence: { tier: "bounded_scan", value: "totally-unknown-handle", reasonCode: "NO_ACCOUNT_FOUND_IN_BOUNDED_SCAN", candidateCount: 0 },
    matchedPartnerRef: null,
    matchedPartnerAccountRef: null,
    ownerUid: null,
    regionIds: [],
    teamIds: [],
  };
  await writeChannelRecord(channelUnmatched);
}
