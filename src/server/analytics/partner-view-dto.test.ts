import { describe, expect, it } from "vitest";

import type { ScopeGrant } from "@/server/authz/types";

import { buildPartnerAnalyticsView, buildPartnerPlatformSwitch, displayedLabelRefs, selectPartnerViewRecords, type PartnerAnalyticsViewDto } from "./partner-view-dto";
import { partnerAnalyticsPath, partnerExplorerPath, partnerProfilePath } from "./partner-view-links";
import type { PartnerViewSelection } from "./partner-view-metrics";
import type { PlatformViewLabelInputs } from "./platform-view-dto";
import type { AnalyticsChannelSourceRecordDoc, AnalyticsContentSourceRecordDoc } from "./types";

const grantBase = { uid: "actor-1", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "system:test" };
const regionGrant = (region: string) => ({ type: "REGION", region, ...grantBase }) as ScopeGrant;

let n = 0;
function content(overrides: Partial<AnalyticsContentSourceRecordDoc>): AnalyticsContentSourceRecordDoc {
  n++;
  return {
    uid: `uid-secret-${n}`,
    sourceRef: `SRC-SECRET-${String(n).padStart(3, "0")}`,
    batchRef: "batch-secret-1",
    sheetName: "Posts",
    sourceRowNumber: 7,
    platform: "instagram",
    rowIdentityKey: `k${n}`,
    rawPostId: null,
    rawPostUrl: "https://instagram.com/p/RAW-URL-SECRET",
    rawPostType: null,
    rawPostDateTime: null,
    rawMediaUrl: "https://cdn.example/RAW-MEDIA-SECRET",
    rawCaption: "RAW CAPTION MUST NOT LEAK",
    rawComments: null,
    rawLikes: null,
    rawViews: null,
    rawFollowers: null,
    rawUsername: "raw_user_secret",
    rawEngagement: null,
    rawAccountOrChannelName: null,
    normalizedUrl: "https://instagram.com/p/NORMALIZED-URL-SECRET",
    postDateTimeIso: "2026-08-12T10:00:00.000Z",
    comments: 3,
    likes: 30,
    views: 300,
    profileFollowers: null,
    engagement: 33,
    reportingPeriod: { start: "2026-08-01", end: "2026-08-31" },
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: "https://x", reasonCode: null, candidateCount: 1 },
    matchedContentRef: "content-ref-secret",
    matchedAssignmentRef: "assignment-ref-secret",
    matchedCampaignRef: "campaign-ref-secret",
    matchedPartnerRef: "partner-secret-1",
    matchedPartnerAccountRef: "account-ref-secret-a",
    correctionRevision: 1,
    ownerUid: "owner-uid-secret",
    regionIds: ["Kerala"],
    teamIds: [],
    createdAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

function channel(overrides: Partial<AnalyticsChannelSourceRecordDoc>): AnalyticsChannelSourceRecordDoc {
  n++;
  return {
    uid: `chan-uid-secret-${n}`,
    sourceRef: `CHAN-SECRET-${String(n).padStart(3, "0")}`,
    batchRef: "batch-secret-1",
    sheetName: "Channels",
    sourceRowNumber: 3,
    platform: "instagram",
    rowIdentityKey: `ck${n}`,
    rawUsername: "raw_channel_secret",
    rawProfileUrl: null,
    rawPlatformAccountId: null,
    rawFollowers: null,
    rawAccountOrChannelName: null,
    normalizedProfileUrl: null,
    profileFollowers: 5000,
    reportingPeriod: { start: "2026-07-01", end: "2026-07-31" },
    matchState: "MATCHED",
    matchEvidence: { tier: "identity_claim", value: "x", reasonCode: null, candidateCount: 1 },
    matchedPartnerRef: "partner-secret-1",
    matchedPartnerAccountRef: "account-ref-secret-a",
    correctionRevision: 1,
    ownerUid: "owner-uid-secret",
    regionIds: ["Kerala"],
    teamIds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function inputs(overrides: Partial<PlatformViewLabelInputs> = {}): PlatformViewLabelInputs {
  return {
    actorUid: "actor-1",
    grants: [regionGrant("Kerala")],
    partners: new Map(),
    partnerAccounts: new Map([
      ["account-ref-secret-a", { displayName: "Main IG", handle: "mainig", platformAccountId: null }],
      ["account-ref-secret-b", { displayName: null, handle: "second_ig", platformAccountId: null }],
      ["account-ref-secret-yt", { displayName: "Main YT", handle: null, platformAccountId: null }],
    ]),
    campaigns: new Map([["campaign-ref-secret", { uid: "campaign-uid-1", name: "Monsoon Launch", ownerUid: null, regionIds: ["Kerala"], teamIds: [] }]]),
    batchFilenames: new Map([["batch-secret-1", "export.xlsx"]]),
    ...overrides,
  };
}

const CONTENT = [
  content({ platform: "instagram", views: 1000, likes: 100, comments: 10, engagement: 55, matchedPartnerAccountRef: "account-ref-secret-a" }),
  content({ platform: "instagram", views: 400, likes: null, comments: null, engagement: null, matchedPartnerAccountRef: "account-ref-secret-b", matchedCampaignRef: null, postDateTimeIso: "2026-08-20T10:00:00.000Z" }),
  content({ platform: "youtube", views: 7000, likes: 700, comments: 70, engagement: 500, matchedPartnerAccountRef: "account-ref-secret-yt", postDateTimeIso: "2026-08-15T10:00:00.000Z" }),
];
const CHANNEL = [
  channel({ platform: "instagram", profileFollowers: 5000, matchedPartnerAccountRef: "account-ref-secret-a" }),
  channel({ platform: "instagram", profileFollowers: 300, matchedPartnerAccountRef: "account-ref-secret-b" }),
  channel({ platform: "youtube", profileFollowers: 9000, matchedPartnerAccountRef: "account-ref-secret-yt" }),
];

function view(selection: PartnerViewSelection, overrides: Partial<PlatformViewLabelInputs> = {}, records = { content: CONTENT, channel: CHANNEL }): PartnerAnalyticsViewDto {
  const selected = selectPartnerViewRecords(records.content, records.channel, selection);
  return buildPartnerAnalyticsView({ partnerRef: "partner-secret-1", partnerDisplayName: "Creator House", selected, coverage: { contentTruncated: false, channelTruncated: false }, inputs: inputs(overrides) });
}

// Collects every [path, value] leaf of the DTO.
function leaves(value: unknown, path: string[] = []): { path: string[]; value: unknown }[] {
  if (value === null || typeof value !== "object") return [{ path, value }];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leaves(child, [...path, key]));
}
function allKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [key, ...allKeys(child)]);
}

describe("Partner Analytics DTO - shape and redaction", () => {
  it("carries the Partner's display name ONLY - no restricted profile field", () => {
    const dto = view("all");
    expect(dto.partner).toEqual({ displayName: "Creator House" });
    expect(JSON.stringify(dto)).not.toMatch(/legalName|email|phone|kyc|bank|tax|status|tier/i);
  });

  it("no raw refs / uids / urls anywhere - the ONLY strings that may embed a ref are same-origin *Href paths", () => {
    const dto = view("all");
    const secrets = ["SRC-SECRET", "CHAN-SECRET", "uid-secret", "batch-secret", "content-ref-secret", "assignment-ref-secret", "campaign-ref-secret", "account-ref-secret", "owner-uid-secret", "RAW CAPTION", "RAW-URL-SECRET", "RAW-MEDIA-SECRET", "NORMALIZED-URL-SECRET", "raw_user_secret", "raw_channel_secret", "https://"];
    for (const { path, value } of leaves(dto)) {
      if (typeof value !== "string") continue;
      const key = path[path.length - 1] ?? "";
      if (/href$/i.test(key)) {
        expect(value, path.join(".")).toMatch(/^\//); // same-origin path, never an absolute URL
        continue;
      }
      for (const secret of secrets) expect(value, `${path.join(".")} leaks ${secret}`).not.toContain(secret);
    }
    // Refs that are hrefs are the canonical, URL-encoded ones only.
    const hrefs = leaves(dto).filter((l) => /href$/i.test(l.path[l.path.length - 1] ?? "")).map((l) => l.value as string);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      for (const secret of ["uid-secret", "owner-uid-secret", "SRC-SECRET", "batch-secret", "content-ref-secret", "campaign-ref-secret"]) expect(href).not.toContain(secret);
    }
  });

  it("no score / rating / blended / composite / weighted keys, and no Reach / Watch Time / Impressions / Shares / Saves / subscriber-growth keys", () => {
    const keys = allKeys(view("all")).join(" ");
    expect(keys).not.toMatch(/score|rating|blend|composite|weight|index/i);
    expect(keys).not.toMatch(/reach|watch|impression|share|save|subscriber|growth|delta/i);
  });

  it("no follower total anywhere: one row per account, no platform/partner follower sum key or value", () => {
    const dto = view("all");
    expect(allKeys(dto.partnerAccounts).join(" ")).not.toMatch(/total(?!Accounts)|sum|growth|subscriber/i);
    expect(Object.keys(dto.partnerAccounts).sort()).toEqual(["rows", "totalAccounts"]);
    expect(dto.partnerAccounts.rows).toHaveLength(3);
    expect(dto.partnerAccounts.rows.map((r) => r.profileFollowers).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([300, 5000, 9000]);
    // 5000 + 300 = 5300, +9000 = 14300 appear nowhere as a number.
    const json = JSON.stringify(dto);
    for (const fake of [5300, 14300, 9300]) expect(new RegExp(`[:,\\[]${fake}[,}\\]]`).test(json), `fake total ${fake}`).toBe(false);
  });

  it("two accounts on one platform stay distinct rows (label / handle from their own account)", () => {
    const ig = view("instagram").partnerAccounts.rows;
    expect(ig).toHaveLength(2);
    expect(ig.map((r) => r.accountLabel).sort()).toEqual(["Main IG", "second_ig"]);
    expect(ig.every((r) => r.platform === "instagram")).toBe(true);
    expect(ig.find((r) => r.accountLabel === "Main IG")).toMatchObject({ accountHandle: "mainig", profileFollowers: 5000, contentRecords: 1, channelRecords: 1 });
  });

  it("an account row's Explorer link filters to exactly that account and its platform", () => {
    const rows = view("all").partnerAccounts.rows;
    for (const row of rows) {
      expect(row.explorerHref).toMatch(/^\/analytics\/explorer\?platform=(instagram|youtube)&recordKind=content&partnerAccountRef=account-ref-secret-/);
    }
  });
});

describe("Partner Analytics DTO - All vs single platform", () => {
  it("All keeps the platforms separate; a single selection contains nothing of the other", () => {
    const all = view("all");
    expect(all.platformPerformance.map((c) => c.platform)).toEqual(["instagram", "youtube"]);
    expect(all.publishedContent.rows.map((r) => r.platform).sort()).toEqual(["instagram", "instagram", "youtube"]);
    const yt = view("youtube");
    expect(yt.platformPerformance.map((c) => c.platform)).toEqual(["youtube"]);
    expect(yt.publishedContent.rows.every((r) => r.platform === "youtube")).toBe(true);
    expect(yt.partnerAccounts.rows.every((r) => r.platform === "youtube")).toBe(true);
    const json = JSON.stringify(yt);
    for (const igOnly of [1000, 400, 5000, 300]) expect(new RegExp(`[:,\\[]${igOnly}[,}\\]]`).test(json), `Instagram value ${igOnly} leaked into YouTube view`).toBe(false);
  });

  it("Views are not combined on All but are on a single platform", () => {
    expect(view("all").kpis.views).toMatchObject({ total: null, totalBasis: "not_combined" });
    expect(view("instagram").kpis.views).toMatchObject({ total: 1400, totalBasis: "single_platform" });
  });

  it("Published content: bounded newest-first rows with the true total disclosed", () => {
    const dto = view("all");
    expect(dto.publishedContent.total).toBe(3);
    expect(dto.publishedContent.rows.map((r) => r.views)).toEqual([400, 7000, 1000]); // 08-20, 08-15, 08-12
    const many = Array.from({ length: 25 }, (_, i) => content({ views: i + 1, postDateTimeIso: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z` }));
    const big = view("instagram", {}, { content: many, channel: [] });
    expect(big.publishedContent.total).toBe(25);
    expect(big.publishedContent.rows).toHaveLength(10);
  });

  it("content rows carry NO Partner label/link (the page is that Partner) and expose no post URL", () => {
    for (const row of view("all").publishedContent.rows) {
      expect(Object.keys(row).sort()).toEqual(["accountLabel", "campaignLabel", "comments", "engagement", "likes", "matchState", "platform", "publishedAt", "reportingPeriod", "source", "views"].sort());
    }
  });

  it("Top Content: Views basis with per-platform groups and ranks; rows keep the same safe shape", () => {
    const { topContent } = view("all");
    expect(topContent.basis).toBe("views");
    expect(topContent.note).toMatch(/Ranked by Views/);
    expect(topContent.groups.map((g) => [g.platform, g.rows.map((r) => [r.rank, r.views])])).toEqual([
      ["instagram", [[1, 1000], [2, 400]]],
      ["youtube", [[1, 7000]]],
    ]);
  });

  it("Top Content falls back to Engagement (labelled) when no record has Views, and to neutral when neither exists", () => {
    const noViews = { content: [content({ views: null, engagement: 12 }), content({ views: null, engagement: 99 })], channel: [] };
    const eng = view("instagram", {}, noViews).topContent;
    expect(eng.basis).toBe("engagement");
    expect(eng.note).toContain("Ranked by Engagement (no Views reported)");
    expect(eng.groups[0]!.rows.map((r) => r.engagement)).toEqual([99, 12]);
    const none = view("all", {}, { content: [content({ views: null, engagement: null })], channel: [] }).topContent;
    expect(none).toEqual({ basis: "none", note: "No content with reported Views or Engagement", groups: [] });
  });

  it("empty data: neutral throughout, never zero performance", () => {
    const dto = view("all", {}, { content: [], channel: [] });
    expect(dto.period.label).toBe("No source data yet");
    expect(dto.kpis.publishedContent.total).toBe(0);
    expect(dto.platformPerformance.every((c) => !c.hasData)).toBe(true);
    expect(dto.partnerAccounts).toEqual({ rows: [], totalAccounts: 0 });
    expect(dto.publishedContent).toEqual({ rows: [], total: 0 });
    expect(dto.sourceQuality.content.total).toBe(0);
  });

  it("a mixed-platform window can never leak a second platform into a single-platform view", () => {
    const selected = selectPartnerViewRecords(CONTENT, CHANNEL, "instagram");
    expect(selected.content.every((r) => r.platform === "instagram")).toBe(true);
    expect(selected.channel.every((r) => r.platform === "instagram")).toBe(true);
  });
});

describe("Campaign label - only with feature + Campaign scope", () => {
  it("shown when the Campaign is inside the actor's Campaign Record Scope", () => {
    expect(view("instagram").publishedContent.rows.find((r) => r.views === 1000)!.campaignLabel).toBe("Monsoon Launch");
  });
  it("neutral (null, no name, no ref) when out of scope - the Analytics fact stays visible", () => {
    const dto = view("instagram", { grants: [regionGrant("Goa")] });
    const row = dto.publishedContent.rows.find((r) => r.views === 1000)!;
    expect(row.campaignLabel).toBeNull();
    expect(row.likes).toBe(100);
    expect(JSON.stringify(dto)).not.toContain("Monsoon Launch");
    expect(JSON.stringify(dto)).not.toContain("campaign-ref-secret");
  });
  it("neutral when the campaigns feature was not granted (no Campaign docs supplied)", () => {
    expect(view("instagram", { campaigns: new Map() }).publishedContent.rows.every((r) => r.campaignLabel === null)).toBe(true);
  });
  it("Top Content rows follow the same Campaign redaction", () => {
    const dto = view("instagram", { grants: [regionGrant("Goa")] });
    expect(JSON.stringify(dto.topContent)).not.toContain("Monsoon Launch");
  });
});

describe("displayedLabelRefs - labels only for displayed rows, deduplicated", () => {
  it("collects distinct account / campaign / batch refs across published, top and account rows", () => {
    const selected = selectPartnerViewRecords(CONTENT, CHANNEL, "all");
    const refs = displayedLabelRefs(selected);
    expect(refs.partnerAccountRefs.sort()).toEqual(["account-ref-secret-a", "account-ref-secret-b", "account-ref-secret-yt"]);
    expect(refs.campaignRefs).toEqual(["campaign-ref-secret"]);
    expect(refs.batchRefs).toEqual(["batch-secret-1"]);
  });
});

describe("links", () => {
  it("platform switch: real hrefs, bare path for All, exactly one active, aria state derivable", () => {
    const items = buildPartnerPlatformSwitch("partner-secret-1", "youtube");
    expect(items.map((i) => [i.selection, i.label, i.href, i.active])).toEqual([
      ["all", "All", "/analytics/partner/partner-secret-1", false],
      ["instagram", "Instagram", "/analytics/partner/partner-secret-1?platform=instagram", false],
      ["youtube", "YouTube", "/analytics/partner/partner-secret-1?platform=youtube", true],
    ]);
  });

  it("Explorer / profile links carry the platform ONLY when one is selected; the profile route is the canonical one", () => {
    expect(view("all").links).toMatchObject({
      profileHref: "/partners/partner-secret-1",
      explorerContentHref: "/analytics/explorer?recordKind=content&partnerRef=partner-secret-1",
      explorerChannelHref: "/analytics/explorer?recordKind=channel&partnerRef=partner-secret-1",
    });
    expect(view("instagram").links.explorerContentHref).toBe("/analytics/explorer?platform=instagram&recordKind=content&partnerRef=partner-secret-1");
  });

  it("refs are URL-encoded in every href", () => {
    expect(partnerAnalyticsPath("a b/c?d", "instagram")).toBe("/analytics/partner/a%20b%2Fc%3Fd?platform=instagram");
    expect(partnerProfilePath("a/b")).toBe("/partners/a%2Fb");
    expect(partnerExplorerPath({ partnerAccountRef: "x&y=z", platform: "youtube", recordKind: "channel" })).toBe("/analytics/explorer?platform=youtube&recordKind=channel&partnerAccountRef=x%26y%3Dz");
    expect(partnerAnalyticsPath("p", "all")).toBe("/analytics/partner/p");
    expect(partnerAnalyticsPath("p", null)).toBe("/analytics/partner/p");
  });
});
