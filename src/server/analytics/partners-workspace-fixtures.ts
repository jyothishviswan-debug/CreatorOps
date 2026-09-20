// Step 12F: schema-shaped synthetic Analytics source records for the pure
// workspace unit tests (no Firestore). Test support only - never imported by app code.
import type { AnalyticsChannelSourceRecordDoc, AnalyticsContentSourceRecordDoc } from "./types";

let counter = 0;

export function contentRecord(overrides: Partial<AnalyticsContentSourceRecordDoc> = {}): AnalyticsContentSourceRecordDoc {
  counter++;
  return {
    uid: `uid-secret-${counter}`,
    sourceRef: `SRC-SECRET-${String(counter).padStart(4, "0")}`,
    batchRef: "batch-secret-1",
    sheetName: "Posts",
    sourceRowNumber: 7,
    platform: "instagram",
    rowIdentityKey: `k${counter}`,
    rawPostId: null,
    rawPostUrl: "https://instagram.com/p/RAW-URL-SECRET",
    rawPostType: null,
    rawPostDateTime: null,
    rawMediaUrl: null,
    rawCaption: "RAW CAPTION MUST NOT LEAK",
    rawComments: null,
    rawLikes: null,
    rawViews: null,
    rawFollowers: null,
    rawUsername: "raw_user_secret",
    rawEngagement: null,
    rawAccountOrChannelName: null,
    normalizedUrl: null,
    postDateTimeIso: "2026-08-12T10:00:00.000Z",
    comments: 3,
    likes: 30,
    views: 300,
    profileFollowers: null,
    engagement: 33,
    reportingPeriod: { start: "2026-08-01", end: "2026-08-31" },
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: null, reasonCode: null, candidateCount: 1 },
    matchedContentRef: null,
    matchedAssignmentRef: null,
    matchedCampaignRef: null,
    matchedPartnerRef: "partner-secret-1",
    matchedPartnerAccountRef: null,
    correctionRevision: 1,
    ownerUid: null,
    regionIds: ["Kerala"],
    teamIds: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

export function channelRecord(overrides: Partial<AnalyticsChannelSourceRecordDoc> = {}): AnalyticsChannelSourceRecordDoc {
  counter++;
  return {
    uid: `chan-uid-secret-${counter}`,
    sourceRef: `CHAN-SECRET-${String(counter).padStart(4, "0")}`,
    batchRef: "batch-secret-1",
    sheetName: "Channels",
    sourceRowNumber: 3,
    platform: "instagram",
    rowIdentityKey: `ck${counter}`,
    rawUsername: "raw_channel_secret",
    rawProfileUrl: null,
    rawPlatformAccountId: null,
    rawFollowers: null,
    rawAccountOrChannelName: null,
    normalizedProfileUrl: null,
    profileFollowers: 5000,
    reportingPeriod: { start: "2026-08-01", end: "2026-08-31" },
    matchState: "MATCHED",
    matchEvidence: { tier: "none", value: null, reasonCode: null, candidateCount: 0 },
    matchedPartnerRef: "partner-secret-1",
    matchedPartnerAccountRef: null,
    correctionRevision: 1,
    ownerUid: null,
    regionIds: ["Kerala"],
    teamIds: [],
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

export const month = (m: string) => ({ start: `${m}-01`, end: `${m}-28` });
