import { describe, expect, it } from "vitest";

import type { ScopeGrant } from "@/server/authz/types";

import { authorizedCampaignLabel, buildPartnerAccountRowDtos, buildPublishedContentRowDtos, partnerAccountLabelOf, type PlatformViewLabelInputs } from "./platform-view-dto";
import { selectLatestAccountSnapshots } from "./platform-view-metrics";
import type { AnalyticsChannelSourceRecordDoc, AnalyticsContentSourceRecordDoc } from "./types";

const grantBase = { uid: "actor-1", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "system:test" };
const regionGrant = (region: string) => ({ type: "REGION", region, ...grantBase }) as ScopeGrant;
const globalGrant = { type: "GLOBAL", ...grantBase } as ScopeGrant;

function contentRecord(overrides: Partial<AnalyticsContentSourceRecordDoc>): AnalyticsContentSourceRecordDoc {
  return {
    uid: "u",
    sourceRef: "SRC-INTERNAL-REF",
    batchRef: "batch-1",
    sheetName: "Posts",
    sourceRowNumber: 7,
    platform: "instagram",
    rowIdentityKey: "k",
    rawPostId: null,
    rawPostUrl: null,
    rawPostType: null,
    rawPostDateTime: null,
    rawMediaUrl: null,
    rawCaption: "RAW CAPTION MUST NOT LEAK",
    rawComments: null,
    rawLikes: null,
    rawViews: null,
    rawFollowers: null,
    rawUsername: "raw_user",
    rawEngagement: null,
    rawAccountOrChannelName: null,
    normalizedUrl: null,
    postDateTimeIso: "2026-08-12T10:00:00.000Z",
    comments: 3,
    likes: 30,
    views: null,
    profileFollowers: null,
    engagement: null,
    reportingPeriod: null,
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: "https://x", reasonCode: null, candidateCount: 1 },
    matchedContentRef: "content-ref-secret",
    matchedAssignmentRef: "assignment-ref-secret",
    matchedCampaignRef: "campaign-ref-1",
    matchedPartnerRef: "partner-ref-1",
    matchedPartnerAccountRef: "account-ref-1",
    correctionRevision: 1,
    ownerUid: "owner-uid-secret",
    regionIds: ["Kerala"],
    teamIds: [],
    createdAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

function inputs(overrides: Partial<PlatformViewLabelInputs> = {}): PlatformViewLabelInputs {
  return {
    actorUid: "actor-1",
    grants: [regionGrant("Kerala")],
    partners: new Map([["partner-ref-1", { displayName: "Creator House" }]]),
    partnerAccounts: new Map([["account-ref-1", { displayName: null, handle: "creatorhouse", platformAccountId: null }]]),
    campaigns: new Map([["campaign-ref-1", { uid: "campaign-uid-1", name: "Monsoon Launch", ownerUid: null, regionIds: ["Kerala"], teamIds: [] }]]),
    batchFilenames: new Map([["batch-1", "instagram-export.xlsx"]]),
    ...overrides,
  };
}

describe("authorizedCampaignLabel - Campaign context only when the actor may access that Campaign", () => {
  it("is shown when the Campaign is inside the actor's Campaign Record Scope", () => {
    expect(authorizedCampaignLabel("campaign-ref-1", inputs())).toBe("Monsoon Launch");
  });
  it("is ABSENT when the Campaign is outside the actor's scope (even though the analytics record itself is in scope)", () => {
    expect(authorizedCampaignLabel("campaign-ref-1", inputs({ grants: [regionGrant("Maharashtra")] }))).toBeNull();
  });
  it("is absent when the campaigns feature was not granted (caller passes no Campaign docs)", () => {
    expect(authorizedCampaignLabel("campaign-ref-1", inputs({ campaigns: new Map() }))).toBeNull();
  });
  it("a GLOBAL grant sees it; an unresolvable or missing ref never renders", () => {
    expect(authorizedCampaignLabel("campaign-ref-1", inputs({ grants: [globalGrant] }))).toBe("Monsoon Launch");
    expect(authorizedCampaignLabel("unknown", inputs())).toBeNull();
    expect(authorizedCampaignLabel(null, inputs())).toBeNull();
  });
  it("honors the dedicated CAMPAIGN grant and an EXPLICIT_RECORD grant (accepted Campaign Record Scope)", () => {
    const campaignGrant = { type: "CAMPAIGN", campaignId: "campaign-uid-1", ...grantBase } as ScopeGrant;
    expect(authorizedCampaignLabel("campaign-ref-1", inputs({ grants: [campaignGrant], campaigns: new Map([["campaign-ref-1", { uid: "campaign-uid-1", name: "Monsoon Launch", ownerUid: null, regionIds: ["Goa"], teamIds: [] }]]) }))).toBe("Monsoon Launch");
  });
});

describe("buildPublishedContentRowDtos - actor-safe rows", () => {
  it("emits labels, dates, metrics and provenance - and never an internal ref, uid, caption or raw username", () => {
    const rows = buildPublishedContentRowDtos([contentRecord({})], inputs());
    expect(rows).toEqual([
      {
        publishedAt: "2026-08-12T10:00:00.000Z",
        reportingPeriod: null,
        partnerLabel: "Creator House",
        // Step 12E: no Partner is in the openable set here -> plain text, no link.
        partnerAnalyticsHref: null,
        accountLabel: "creatorhouse",
        campaignLabel: "Monsoon Launch",
        matchState: "MATCHED",
        views: null,
        engagement: null,
        likes: 30,
        comments: 3,
        source: "instagram-export.xlsx · sheet Posts · row 7",
      },
    ]);
    const json = JSON.stringify(rows);
    for (const secret of ["SRC-INTERNAL-REF", "content-ref-secret", "assignment-ref-secret", "campaign-ref-1", "partner-ref-1", "account-ref-1", "owner-uid-secret", "RAW CAPTION", "raw_user", "batch-1"]) {
      expect(json, `DTO leaks ${secret}`).not.toContain(secret);
    }
  });
  it("Step 12E: partnerAnalyticsHref is the ONE new key - set only for an openable Partner, carrying the row's platform; nothing else leaks", () => {
    const openable = inputs({ openablePartnerRefs: new Set(["partner-ref-1"]) });
    const [row] = buildPublishedContentRowDtos([contentRecord({ platform: "youtube" })], openable);
    expect(row!.partnerAnalyticsHref).toBe("/analytics/partner/partner-ref-1?platform=youtube");
    // The href is the only place the canonical ref may appear.
    const { partnerAnalyticsHref: _href, ...rest } = row!;
    void _href;
    const json = JSON.stringify(rest);
    for (const secret of ["SRC-INTERNAL-REF", "content-ref-secret", "assignment-ref-secret", "campaign-ref-1", "partner-ref-1", "account-ref-1", "owner-uid-secret", "RAW CAPTION", "raw_user", "batch-1"]) {
      expect(json, `DTO leaks ${secret}`).not.toContain(secret);
    }
    // A Partner outside the openable set (or no set at all) never gets a link.
    expect(buildPublishedContentRowDtos([contentRecord({})], inputs({ openablePartnerRefs: new Set(["someone-else"]) }))[0]!.partnerAnalyticsHref).toBeNull();
    expect(buildPublishedContentRowDtos([contentRecord({ matchedPartnerRef: null })], openable)[0]!.partnerAnalyticsHref).toBeNull();
    // A platform other than instagram|youtube opens the bare (All) path, never an arbitrary ?platform=.
    expect(buildPublishedContentRowDtos([contentRecord({ platform: "tiktok" })], openable)[0]!.partnerAnalyticsHref).toBe("/analytics/partner/partner-ref-1");
  });
  it("missing metrics stay null (rendered Unavailable), never 0", () => {
    const [row] = buildPublishedContentRowDtos([contentRecord({ views: null, likes: null, comments: null, engagement: null })], inputs());
    expect([row!.views, row!.engagement, row!.likes, row!.comments]).toEqual([null, null, null, null]);
  });
  it("unresolved / unauthorized labels are null placeholders, not raw refs; provenance falls back to the neutral batch label", () => {
    const [row] = buildPublishedContentRowDtos([contentRecord({})], inputs({ partners: new Map(), partnerAccounts: new Map(), campaigns: new Map(), batchFilenames: new Map() }));
    expect(row).toMatchObject({ partnerLabel: null, accountLabel: null, campaignLabel: null, source: "Import batch · sheet Posts · row 7" });
  });
  it("keeps the record's real posted date, falling back to the period only via the DTO's own reportingPeriod", () => {
    const [row] = buildPublishedContentRowDtos([contentRecord({ postDateTimeIso: null, reportingPeriod: { start: "2026-07-01", end: "2026-07-31" } })], inputs());
    expect(row).toMatchObject({ publishedAt: null, reportingPeriod: { start: "2026-07-01", end: "2026-07-31" } });
  });
});

describe("buildPartnerAccountRowDtos - one row per account, snapshot semantics", () => {
  const channelRecord = (overrides: Partial<AnalyticsChannelSourceRecordDoc>): AnalyticsChannelSourceRecordDoc => ({
    uid: "c",
    sourceRef: "CHANNEL-INTERNAL-REF",
    batchRef: "batch-1",
    sheetName: "Channels",
    sourceRowNumber: 3,
    platform: "youtube",
    rowIdentityKey: "ck",
    rawUsername: "raw_channel_user",
    rawProfileUrl: null,
    rawPlatformAccountId: null,
    rawFollowers: null,
    rawAccountOrChannelName: null,
    normalizedProfileUrl: null,
    profileFollowers: 5000,
    reportingPeriod: { start: "2026-07-01", end: "2026-07-31" },
    matchState: "MATCHED",
    matchEvidence: { tier: "identity_claim", value: "x", reasonCode: null, candidateCount: 1 },
    matchedPartnerRef: "partner-ref-1",
    matchedPartnerAccountRef: "account-ref-1",
    correctionRevision: 1,
    ownerUid: "owner-uid-secret",
    regionIds: ["Kerala"],
    teamIds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });

  it("carries ONE account's snapshot value, period and freshness - and exposes no platform-wide total", () => {
    const selections = selectLatestAccountSnapshots(
      [channelRecord({ sourceRef: "a" }), channelRecord({ sourceRef: "b", matchedPartnerAccountRef: "account-ref-2", profileFollowers: 7000 })],
      "youtube",
    );
    const rows = buildPartnerAccountRowDtos(selections, inputs({ partnerAccounts: new Map([["account-ref-1", { displayName: "CH Main", handle: "chmain", platformAccountId: null }], ["account-ref-2", { displayName: null, handle: null, platformAccountId: "UCabc" }]]) }));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.profileFollowers).sort()).toEqual([5000, 7000]);
    expect(rows.map((r) => r.accountLabel).sort()).toEqual(["CH Main", "UCabc"]);
    expect(rows.find((r) => r.accountLabel === "CH Main")).toMatchObject({ accountHandle: "chmain", partnerLabel: "Creator House", reportingPeriod: { start: "2026-07-01", end: "2026-07-31" }, snapshotAt: "2026-08-01T00:00:00.000Z", source: "instagram-export.xlsx · sheet Channels · row 3" });
    // DTO shape: no total / sum / growth / subscribers key, no internal ref or uid
    const keys = Object.keys(rows[0]!).join(" ");
    expect(keys).not.toMatch(/total|sum|growth|subscriber|delta|change/i);
    const json = JSON.stringify(rows);
    for (const secret of ["CHANNEL-INTERNAL-REF", "account-ref-1", "partner-ref-1", "owner-uid-secret", "raw_channel_user"]) expect(json).not.toContain(secret);
    // 12000 (= 5000 + 7000) appears nowhere.
    expect(json).not.toContain("12000");
  });
  it("Step 12E: an account row links to Partner Analytics only for an openable Partner", () => {
    const selections = selectLatestAccountSnapshots([channelRecord({})], "youtube");
    const [open] = buildPartnerAccountRowDtos(selections, inputs({ openablePartnerRefs: new Set(["partner-ref-1"]) }));
    expect(open!.partnerAnalyticsHref).toBe("/analytics/partner/partner-ref-1?platform=youtube");
    const [closed] = buildPartnerAccountRowDtos(selections, inputs());
    expect(closed!.partnerAnalyticsHref).toBeNull();
  });
  it("an account whose snapshot has no verified value is Unavailable (null), and unresolved labels are null", () => {
    const selections = selectLatestAccountSnapshots([channelRecord({ profileFollowers: null })], "youtube");
    const [row] = buildPartnerAccountRowDtos(selections, inputs({ partners: new Map(), partnerAccounts: new Map() }));
    expect(row).toMatchObject({ profileFollowers: null, partnerLabel: null, accountLabel: null, accountHandle: null });
  });
});

describe("partnerAccountLabelOf - same precedence as the Data Explorer", () => {
  it("displayName, then handle, then platformAccountId, then a neutral fallback", () => {
    expect(partnerAccountLabelOf({ displayName: "D", handle: "h", platformAccountId: "p" })).toBe("D");
    expect(partnerAccountLabelOf({ displayName: null, handle: "h", platformAccountId: "p" })).toBe("h");
    expect(partnerAccountLabelOf({ displayName: null, handle: null, platformAccountId: "p" })).toBe("p");
    expect(partnerAccountLabelOf({ displayName: null, handle: null, platformAccountId: null })).toBe("Unnamed account");
  });
});
