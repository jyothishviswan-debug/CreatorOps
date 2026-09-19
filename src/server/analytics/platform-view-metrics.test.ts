import { describe, expect, it } from "vitest";

import {
  aggregatePlatformKpis,
  buildPlatformKpiData,
  buildPlatformSourceQuality,
  buildPlatformTrend,
  comparePublishedContentNewestFirst,
  parsePlatformViewId,
  PLATFORM_VIEW_COPY,
  PLATFORM_VIEW_IDS,
  PUBLISHED_CONTENT_ROW_LIMIT,
  selectLatestAccountSnapshots,
  selectPublishedContentRecords,
} from "./platform-view-metrics";
import type { AnalyticsChannelSourceRecordDoc, AnalyticsContentSourceRecordDoc } from "./types";

function content(overrides: Partial<AnalyticsContentSourceRecordDoc>): AnalyticsContentSourceRecordDoc {
  return {
    uid: "u",
    sourceRef: "u",
    batchRef: "b",
    sheetName: "s",
    sourceRowNumber: 1,
    platform: "instagram",
    rowIdentityKey: "k",
    rawPostId: null,
    rawPostUrl: null,
    rawPostType: null,
    rawPostDateTime: null,
    rawMediaUrl: null,
    rawCaption: null,
    rawComments: null,
    rawLikes: null,
    rawViews: null,
    rawFollowers: null,
    rawUsername: null,
    rawEngagement: null,
    rawAccountOrChannelName: null,
    normalizedUrl: null,
    postDateTimeIso: null,
    comments: null,
    likes: null,
    views: null,
    profileFollowers: null,
    engagement: null,
    reportingPeriod: null,
    matchState: "UNMATCHED",
    matchEvidence: { tier: "none", value: null, reasonCode: null, candidateCount: 0 },
    matchedContentRef: null,
    matchedAssignmentRef: null,
    matchedCampaignRef: null,
    matchedPartnerRef: null,
    matchedPartnerAccountRef: null,
    correctionRevision: 1,
    ownerUid: null,
    regionIds: [],
    teamIds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function channel(overrides: Partial<AnalyticsChannelSourceRecordDoc>): AnalyticsChannelSourceRecordDoc {
  return {
    uid: "c",
    sourceRef: "c",
    batchRef: "b",
    sheetName: "s",
    sourceRowNumber: 1,
    platform: "instagram",
    rowIdentityKey: "ck",
    rawUsername: null,
    rawProfileUrl: null,
    rawPlatformAccountId: null,
    rawFollowers: null,
    rawAccountOrChannelName: null,
    normalizedProfileUrl: null,
    profileFollowers: null,
    reportingPeriod: null,
    matchState: "UNMATCHED",
    matchEvidence: { tier: "none", value: null, reasonCode: null, candidateCount: 0 },
    matchedPartnerRef: null,
    matchedPartnerAccountRef: null,
    correctionRevision: 1,
    ownerUid: null,
    regionIds: [],
    teamIds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

// Every key of a value, recursively - the "key walker" used to prove no
// unsupported metric / aggregate key is ever synthesized.
function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, into));
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      into.add(key);
      allKeys(v, into);
    }
  }
  return into;
}

describe("parsePlatformViewId - the shared normalizePlatformIdentifier, closed to instagram/youtube", () => {
  it("accepts the two platforms after normalization", () => {
    expect(parsePlatformViewId("instagram")).toBe("instagram");
    expect(parsePlatformViewId("Instagram")).toBe("instagram");
    expect(parsePlatformViewId(" YOUTUBE ")).toBe("youtube");
    expect(parsePlatformViewId("YouTube")).toBe("youtube");
  });
  it("rejects near-misses, other platforms, empty and non-strings", () => {
    expect(parsePlatformViewId("insta")).toBeNull();
    expect(parsePlatformViewId("tiktok")).toBeNull();
    expect(parsePlatformViewId("instagram.com")).toBeNull();
    expect(parsePlatformViewId("")).toBeNull();
    expect(parsePlatformViewId("   ")).toBeNull();
    expect(parsePlatformViewId(undefined)).toBeNull();
    expect(parsePlatformViewId(["instagram"])).toBeNull();
  });
  it("supports exactly the two platform ids, each with its own copy", () => {
    expect([...PLATFORM_VIEW_IDS]).toEqual(["instagram", "youtube"]);
    expect(PLATFORM_VIEW_COPY.instagram.title).toBe("Instagram Analytics");
    expect(PLATFORM_VIEW_COPY.youtube.title).toBe("YouTube Analytics");
  });
});

describe("aggregatePlatformKpis - platform isolation and honest metrics", () => {
  const mixed = [
    content({ sourceRef: "ig1", platform: "instagram", views: 100, likes: 10, comments: 1, engagement: 7 }),
    content({ sourceRef: "ig2", platform: "instagram", views: 50, likes: 5, comments: null, engagement: null }),
    content({ sourceRef: "yt1", platform: "youtube", views: 9000, likes: 900, comments: 90, engagement: 700 }),
    content({ sourceRef: "tt1", platform: "tiktok", views: 1, likes: 1, comments: 1, engagement: 1 }),
  ];

  it("only the requested platform contributes (mixed-platform input never leaks)", () => {
    const ig = aggregatePlatformKpis(mixed, "instagram");
    expect(ig.publishedContent).toBe(2);
    expect(ig.views).toEqual({ total: 150, recordsWithValue: 2, recordsTotal: 2 });
    const yt = aggregatePlatformKpis(mixed, "youtube");
    expect(yt.publishedContent).toBe(1);
    expect(yt.views.total).toBe(9000);
  });

  it("Published Content count is platform-specific", () => {
    expect(aggregatePlatformKpis(mixed, "instagram").publishedContent).toBe(2);
    expect(aggregatePlatformKpis(mixed, "youtube").publishedContent).toBe(1);
  });

  it("Views uses only views; Likes/Comments use their own fields; Engagement only the source-reported engagement (never likes + comments)", () => {
    const ig = aggregatePlatformKpis(mixed, "instagram");
    expect(ig.views.total).toBe(150);
    expect(ig.likes.total).toBe(15);
    expect(ig.comments.total).toBe(1);
    expect(ig.engagement.total).toBe(7);
    expect(ig.engagement.total).not.toBe(ig.likes.total! + ig.comments.total!);
  });

  it("engagement stays Unavailable (null, never derived) when only likes/comments are reported", () => {
    const records = [content({ likes: 40, comments: 8, views: 10, engagement: null })];
    const kpis = aggregatePlatformKpis(records, "instagram");
    expect(kpis.engagement).toEqual({ total: null, recordsWithValue: 0, recordsTotal: 1 });
    expect(buildPlatformKpiData(kpis).find((k) => k.label === "Engagement")!.value).toBe("Unavailable");
  });

  it("missing metric -> null/Unavailable, never 0: all-missing, some-missing, and a genuine reported 0", () => {
    const allMissing = aggregatePlatformKpis([content({}), content({ sourceRef: "b" })], "instagram");
    expect(allMissing.views.total).toBeNull();
    expect(allMissing.likes.total).toBeNull();
    const someMissing = aggregatePlatformKpis([content({ views: 12 }), content({ sourceRef: "b", views: null })], "instagram");
    expect(someMissing.views).toEqual({ total: 12, recordsWithValue: 1, recordsTotal: 2 });
    const reportedZero = aggregatePlatformKpis([content({ views: 0 })], "instagram");
    expect(reportedZero.views.total).toBe(0); // a genuine source-reported zero is preserved...
    expect(reportedZero.likes.total).toBeNull(); // ...and is never confused with "missing".
  });

  it("an empty platform yields Unavailable KPIs, never zero", () => {
    const kpis = aggregatePlatformKpis([content({ platform: "youtube", views: 5 })], "instagram");
    expect(kpis.publishedContent).toBe(0);
    const data = buildPlatformKpiData(kpis);
    expect(data.map((k) => k.value)).toEqual(["Unavailable", "Unavailable", "Unavailable", "Unavailable", "Unavailable"]);
  });

  it("records differing only by platform casing/whitespace are attributed to the normalized platform", () => {
    const records = [content({ sourceRef: "a", platform: " Instagram ", views: 4 }), content({ sourceRef: "b", platform: "instagram", views: 6 })];
    expect(aggregatePlatformKpis(records, "instagram").views.total).toBe(10);
  });
});

describe("buildPlatformKpiData - the frozen 5-slot row", () => {
  it("is exactly Published content, Views, Engagement, Likes, Comments - no Reach, no derived slot", () => {
    const data = buildPlatformKpiData(aggregatePlatformKpis([content({ views: 1200, likes: 30, comments: 4, engagement: 9 })], "instagram"));
    expect(data.map((k) => k.label)).toEqual(["Published content", "Views", "Engagement", "Likes", "Comments"]);
    expect(data.map((k) => k.label.toLowerCase()).join(" ")).not.toMatch(/reach|shares|saves|watch time|impressions|subscriber/);
    expect(data[1]).toMatchObject({ value: "1K", hint: "source-reported · all 1 record" });
  });
  it("discloses partial coverage instead of implying a complete total", () => {
    const data = buildPlatformKpiData(aggregatePlatformKpis([content({ views: 10 }), content({ sourceRef: "b" }), content({ sourceRef: "c" })], "instagram"));
    expect(data[1]!.hint).toBe("source-reported · 1 of 3 records");
  });
});

describe("buildPlatformTrend - gaps stay null, never zero", () => {
  const period = (start: string, end: string) => ({ start, end });

  it("builds one shared period axis oldest -> newest with null gaps for periods a metric did not report", () => {
    const records = [
      content({ sourceRef: "a", reportingPeriod: period("2026-05-01", "2026-05-31"), views: 100, likes: 10 }),
      content({ sourceRef: "b", reportingPeriod: period("2026-06-01", "2026-06-30"), views: 200 }), // likes not reported in June
      content({ sourceRef: "c", reportingPeriod: period("2026-07-01", "2026-07-31"), views: 300, likes: 30 }),
    ];
    const trend = buildPlatformTrend(records, "instagram");
    expect(trend.periods.map((p) => p.label)).toEqual(["2026-05-01 – 2026-05-31", "2026-06-01 – 2026-06-30", "2026-07-01 – 2026-07-31"]);
    expect(trend.series.map((s) => s.metric)).toEqual(["views", "likes"]);
    expect(trend.series.find((s) => s.metric === "views")!.values).toEqual([100, 200, 300]);
    expect(trend.series.find((s) => s.metric === "likes")!.values).toEqual([10, null, 30]);
  });

  it("sums records that share a period, and only plots supported metrics (no engagement derivation)", () => {
    const records = [
      content({ sourceRef: "a", reportingPeriod: period("2026-05-01", "2026-05-31"), views: 1, likes: 2, comments: 5 }),
      content({ sourceRef: "b", reportingPeriod: period("2026-05-01", "2026-05-31"), views: 3 }),
      content({ sourceRef: "c", reportingPeriod: period("2026-06-01", "2026-06-30"), views: 10, likes: 20, comments: 50 }),
    ];
    const trend = buildPlatformTrend(records, "instagram");
    expect(trend.series.find((s) => s.metric === "views")!.values).toEqual([4, 10]);
    expect(trend.series.find((s) => s.metric === "engagement")).toBeUndefined();
    expect(trend.series.map((s) => s.metric)).toEqual(["views", "likes", "comments"]);
  });

  it("a metric reported in only one period is not plotted (a dot is not a trend) and is disclosed as omitted", () => {
    const records = [
      content({ sourceRef: "a", reportingPeriod: period("2026-05-01", "2026-05-31"), views: 1, engagement: 5 }),
      content({ sourceRef: "b", reportingPeriod: period("2026-06-01", "2026-06-30"), views: 2 }),
    ];
    const trend = buildPlatformTrend(records, "instagram");
    expect(trend.series.map((s) => s.metric)).toEqual(["views"]);
    expect(trend.omittedMetrics).toEqual(["engagement"]);
  });

  it("no series (and no periods) when nothing has two reported periods; never a flat zero line", () => {
    const one = buildPlatformTrend([content({ reportingPeriod: period("2026-05-01", "2026-05-31"), views: 5 })], "instagram");
    expect(one).toEqual({ periods: [], series: [], omittedMetrics: ["views"] });
    const none = buildPlatformTrend([content({}), content({ sourceRef: "b" })], "instagram");
    expect(none).toEqual({ periods: [], series: [], omittedMetrics: [] });
  });

  it("falls back to the record's real IMPORT month (labelled as such) when there is no reporting period", () => {
    const records = [content({ sourceRef: "a", createdAt: "2026-05-10T00:00:00.000Z", views: 1 }), content({ sourceRef: "b", createdAt: "2026-06-10T00:00:00.000Z", views: 2 })];
    const trend = buildPlatformTrend(records, "instagram");
    expect(trend.periods.map((p) => p.label)).toEqual(["Imported 2026-05", "Imported 2026-06"]);
  });

  it("isolates the platform - another platform's periods and values never appear", () => {
    const records = [
      content({ sourceRef: "a", platform: "instagram", reportingPeriod: period("2026-05-01", "2026-05-31"), views: 1 }),
      content({ sourceRef: "b", platform: "instagram", reportingPeriod: period("2026-06-01", "2026-06-30"), views: 2 }),
      content({ sourceRef: "c", platform: "youtube", reportingPeriod: period("2026-07-01", "2026-07-31"), views: 99999 }),
    ];
    const trend = buildPlatformTrend(records, "instagram");
    expect(trend.periods).toHaveLength(2);
    expect(trend.series[0]!.values).toEqual([1, 2]);
  });

  it("is bounded to the most recent periods", () => {
    const records = Array.from({ length: 20 }, (_, i) => content({ sourceRef: `r${i}`, reportingPeriod: period(`2025-${String((i % 12) + 1).padStart(2, "0")}-01`, `2025-${String((i % 12) + 1).padStart(2, "0")}-28`), views: i + 1, createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }));
    expect(buildPlatformTrend(records, "instagram", 5).periods.length).toBeLessThanOrEqual(5);
  });
});

describe("selectPublishedContentRecords - platform-specific, newest first, deterministic and bounded", () => {
  it("orders by the real posted date (newest first), undated last, then import time, then sourceRef", () => {
    const records = [
      content({ sourceRef: "undated", postDateTimeIso: null, createdAt: "2026-09-01T00:00:00.000Z" }),
      content({ sourceRef: "old", postDateTimeIso: "2026-01-01T00:00:00.000Z" }),
      content({ sourceRef: "new", postDateTimeIso: "2026-08-01T00:00:00.000Z" }),
      content({ sourceRef: "tie-b", postDateTimeIso: "2026-05-01T00:00:00.000Z", createdAt: "2026-06-01T00:00:00.000Z" }),
      content({ sourceRef: "tie-a", postDateTimeIso: "2026-05-01T00:00:00.000Z", createdAt: "2026-06-01T00:00:00.000Z" }),
    ];
    const { records: selected } = selectPublishedContentRecords(records, "instagram");
    expect(selected.map((r) => r.sourceRef)).toEqual(["new", "tie-a", "tie-b", "old", "undated"]);
    // deterministic under any input order
    expect(selectPublishedContentRecords([...records].reverse(), "instagram").records.map((r) => r.sourceRef)).toEqual(["new", "tie-a", "tie-b", "old", "undated"]);
  });

  it("returns only the requested platform, bounded, with the full platform total", () => {
    const records = [
      ...Array.from({ length: 14 }, (_, i) => content({ sourceRef: `ig${i}`, platform: "instagram", postDateTimeIso: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` })),
      content({ sourceRef: "yt", platform: "youtube", postDateTimeIso: "2026-09-30T00:00:00.000Z" }),
    ];
    const ig = selectPublishedContentRecords(records, "instagram");
    expect(ig.total).toBe(14);
    expect(ig.records).toHaveLength(PUBLISHED_CONTENT_ROW_LIMIT);
    expect(ig.records.every((r) => r.platform === "instagram")).toBe(true);
    expect(ig.records[0]!.sourceRef).toBe("ig13");
    expect(selectPublishedContentRecords(records, "youtube").records.map((r) => r.sourceRef)).toEqual(["yt"]);
  });

  it("an unparseable posted date sorts as undated", () => {
    expect(comparePublishedContentNewestFirst(content({ sourceRef: "a", postDateTimeIso: "not a date" }), content({ sourceRef: "b", postDateTimeIso: "2026-01-01T00:00:00.000Z" }))).toBeGreaterThan(0);
  });
});

describe("selectLatestAccountSnapshots - one latest snapshot per account, never summed", () => {
  const matched = (over: Partial<AnalyticsChannelSourceRecordDoc>) => channel({ matchState: "MATCHED", matchedPartnerRef: "p1", ...over });

  it("picks the latest snapshot (by period end, then import time) for each account", () => {
    const records = [
      matched({ sourceRef: "a-old", matchedPartnerAccountRef: "acc-a", profileFollowers: 1000, reportingPeriod: { start: "2026-05-01", end: "2026-05-31" } }),
      matched({ sourceRef: "a-new", matchedPartnerAccountRef: "acc-a", profileFollowers: 1500, reportingPeriod: { start: "2026-06-01", end: "2026-06-30" } }),
      matched({ sourceRef: "b-1", matchedPartnerAccountRef: "acc-b", profileFollowers: 200, createdAt: "2026-08-05T00:00:00.000Z" }),
    ];
    const selections = selectLatestAccountSnapshots(records, "instagram");
    expect(selections).toHaveLength(2);
    const a = selections.find((s) => s.partnerAccountRef === "acc-a")!;
    expect(a.snapshot.profileFollowers).toBe(1500);
    expect(a.snapshotCount).toBe(2);
    expect(selections.find((s) => s.partnerAccountRef === "acc-b")!.snapshot.profileFollowers).toBe(200);
  });

  it("does NOT sum follower snapshots: the selection exposes no total/sum/aggregate field anywhere", () => {
    const records = [
      matched({ sourceRef: "a", matchedPartnerAccountRef: "acc-a", profileFollowers: 1000 }),
      matched({ sourceRef: "b", matchedPartnerAccountRef: "acc-b", profileFollowers: 2000 }),
    ];
    const selections = selectLatestAccountSnapshots(records, "instagram");
    const metadata = selections.map(({ partnerAccountRef, snapshotCount }) => ({ partnerAccountRef, snapshotCount }));
    // The selection's own keys: the account, its ONE chosen snapshot record, and a count - no total/sum field.
    expect(new Set(selections.flatMap((s) => Object.keys(s)))).toEqual(new Set(["partnerAccountRef", "snapshot", "snapshotCount"]));
    expect([...allKeys(metadata)].sort()).toEqual(["partnerAccountRef", "snapshotCount"]);
    // the two accounts remain two separate values; 3000 (= 1000 + 2000) exists nowhere in the selection metadata.
    expect(JSON.stringify(metadata)).not.toContain("3000");
    expect(selections.map((s) => s.snapshot.profileFollowers).sort()).toEqual([1000, 2000]);
  });

  it("prefers the latest snapshot that carries a verified value; an account with none is listed as unavailable (null), not dropped or zeroed", () => {
    const records = [
      matched({ sourceRef: "a-old", matchedPartnerAccountRef: "acc-a", profileFollowers: 1000, reportingPeriod: { start: "2026-05-01", end: "2026-05-31" } }),
      matched({ sourceRef: "a-null-newer", matchedPartnerAccountRef: "acc-a", profileFollowers: null, reportingPeriod: { start: "2026-06-01", end: "2026-06-30" } }),
      matched({ sourceRef: "b-null", matchedPartnerAccountRef: "acc-b", profileFollowers: null }),
    ];
    const selections = selectLatestAccountSnapshots(records, "instagram");
    expect(selections.find((s) => s.partnerAccountRef === "acc-a")!.snapshot.profileFollowers).toBe(1000);
    expect(selections.find((s) => s.partnerAccountRef === "acc-b")!.snapshot.profileFollowers).toBeNull();
  });

  it("only MATCHED records with a Partner Account become rows; other platforms never leak", () => {
    const records = [
      matched({ sourceRef: "ok", matchedPartnerAccountRef: "acc-a", profileFollowers: 1 }),
      channel({ sourceRef: "unmatched", matchState: "UNMATCHED", profileFollowers: 5 }),
      channel({ sourceRef: "ambiguous", matchState: "AMBIGUOUS", profileFollowers: 6 }),
      matched({ sourceRef: "no-account", matchedPartnerAccountRef: null, profileFollowers: 7 }),
      matched({ sourceRef: "yt", platform: "youtube", matchedPartnerAccountRef: "acc-yt", profileFollowers: 8 }),
    ];
    expect(selectLatestAccountSnapshots(records, "instagram").map((s) => s.partnerAccountRef)).toEqual(["acc-a"]);
    expect(selectLatestAccountSnapshots(records, "youtube").map((s) => s.partnerAccountRef)).toEqual(["acc-yt"]);
  });
});

describe("buildPlatformSourceQuality", () => {
  it("counts linked / unlinked / ambiguous for content AND channel records of the platform only", () => {
    const contentRecords = [
      content({ sourceRef: "1", matchState: "MATCHED" }),
      content({ sourceRef: "2", matchState: "UNMATCHED" }),
      content({ sourceRef: "3", matchState: "UNMATCHED" }),
      content({ sourceRef: "4", matchState: "AMBIGUOUS" }),
      content({ sourceRef: "yt", platform: "youtube", matchState: "MATCHED" }),
    ];
    const channelRecords = [channel({ sourceRef: "c1", matchState: "MATCHED" }), channel({ sourceRef: "c2", matchState: "AMBIGUOUS" }), channel({ sourceRef: "cyt", platform: "youtube", matchState: "UNMATCHED" })];
    const quality = buildPlatformSourceQuality(contentRecords, channelRecords, "instagram");
    expect(quality.content).toEqual({ total: 4, linked: 1, unlinked: 2, ambiguous: 1 });
    expect(quality.channel).toEqual({ total: 2, linked: 1, unlinked: 0, ambiguous: 1 });
  });

  it("reports how many in-scope records lack each displayed metric (and profile followers for channel records)", () => {
    const quality = buildPlatformSourceQuality(
      [content({ sourceRef: "1", views: 1, likes: 2 }), content({ sourceRef: "2", views: null, likes: 3 }), content({ sourceRef: "3", views: null, likes: null })],
      [channel({ sourceRef: "c1", profileFollowers: 10 }), channel({ sourceRef: "c2", profileFollowers: null })],
      "instagram",
    );
    const entry = (metric: string) => quality.missingMetrics.find((m) => m.metric === metric)!;
    expect(entry("views")).toMatchObject({ kind: "content", missing: 2, total: 3 });
    expect(entry("likes")).toMatchObject({ missing: 1, total: 3 });
    expect(entry("engagement")).toMatchObject({ missing: 3, total: 3 });
    expect(entry("comments")).toMatchObject({ missing: 3, total: 3 });
    expect(entry("profileFollowers")).toMatchObject({ kind: "channel", missing: 1, total: 2 });
  });

  it("freshness is the latest record time per kind (null when none), never an invented date", () => {
    const quality = buildPlatformSourceQuality(
      [content({ createdAt: "2026-08-01T00:00:00.000Z" }), content({ sourceRef: "b", createdAt: "2026-08-09T00:00:00.000Z" }), content({ sourceRef: "yt", platform: "youtube", createdAt: "2027-01-01T00:00:00.000Z" })],
      [],
      "instagram",
    );
    expect(quality.freshness).toEqual({ latestContentAt: "2026-08-09T00:00:00.000Z", latestChannelAt: null, latestAt: "2026-08-09T00:00:00.000Z" });
    expect(buildPlatformSourceQuality([], [], "youtube").freshness).toEqual({ latestContentAt: null, latestChannelAt: null, latestAt: null });
  });
});

describe("no unsupported metric or aggregate is ever synthesized", () => {
  it("the KPI / trend / quality shapes carry no Reach, Shares, Saves, Watch Time, Impressions, subscriber-growth or follower-total key", () => {
    const records = [
      content({ sourceRef: "a", reportingPeriod: { start: "2026-05-01", end: "2026-05-31" }, views: 1, likes: 2, comments: 3, engagement: 4 }),
      content({ sourceRef: "b", reportingPeriod: { start: "2026-06-01", end: "2026-06-30" }, views: 2, likes: 3, comments: 4, engagement: 5 }),
    ];
    const shapes = {
      kpis: aggregatePlatformKpis(records, "instagram"),
      trend: buildPlatformTrend(records, "instagram"),
      quality: buildPlatformSourceQuality(records, [channel({ profileFollowers: 5 })], "instagram"),
    };
    const forbidden = /reach|shares?|saves?|watch|impression|subscriber|growth|totalfollowers|followertotal|platformfollowers/i;
    for (const key of allKeys(shapes)) expect(key, `unexpected key "${key}"`).not.toMatch(forbidden);
    // only the accepted registry metrics appear as trend/KPI keys
    expect(Object.keys(shapes.kpis).sort()).toEqual(["comments", "engagement", "likes", "publishedContent", "views"]);
  });
});
