import { describe, expect, it } from "vitest";

import {
  aggregatePartnerKpis,
  buildPartnerKpiData,
  buildPartnerPlatformCards,
  buildPartnerSourceQuality,
  derivePartnerReportingPeriod,
  parsePartnerViewSelection,
  platformsForSelection,
  selectPartnerAccounts,
  selectTopContent,
  topContentNote,
} from "./partner-view-metrics";
import type { AnalyticsChannelSourceRecordDoc, AnalyticsContentSourceRecordDoc } from "./types";

let counter = 0;
function content(overrides: Partial<AnalyticsContentSourceRecordDoc>): AnalyticsContentSourceRecordDoc {
  counter++;
  return {
    uid: `u${counter}`,
    sourceRef: `src-${String(counter).padStart(4, "0")}`,
    batchRef: "b",
    sheetName: "s",
    sourceRowNumber: 1,
    platform: "instagram",
    rowIdentityKey: `k${counter}`,
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
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: null, reasonCode: null, candidateCount: 1 },
    matchedContentRef: null,
    matchedAssignmentRef: null,
    matchedCampaignRef: null,
    matchedPartnerRef: "partner-1",
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
  counter++;
  return {
    uid: `c${counter}`,
    sourceRef: `chan-${String(counter).padStart(4, "0")}`,
    batchRef: "b",
    sheetName: "s",
    sourceRowNumber: 1,
    platform: "instagram",
    rowIdentityKey: `ck${counter}`,
    rawUsername: null,
    rawProfileUrl: null,
    rawPlatformAccountId: null,
    rawFollowers: null,
    rawAccountOrChannelName: null,
    normalizedProfileUrl: null,
    profileFollowers: null,
    reportingPeriod: null,
    matchState: "MATCHED",
    matchEvidence: { tier: "identity_claim", value: null, reasonCode: null, candidateCount: 1 },
    matchedPartnerRef: "partner-1",
    matchedPartnerAccountRef: null,
    correctionRevision: 1,
    ownerUid: null,
    regionIds: [],
    teamIds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("parsePartnerViewSelection - platform query parsing", () => {
  it("normalizes casing / whitespace and accepts only instagram|youtube", () => {
    expect(parsePartnerViewSelection("instagram")).toBe("instagram");
    expect(parsePartnerViewSelection("Instagram")).toBe("instagram");
    expect(parsePartnerViewSelection(" YOUTUBE ")).toBe("youtube");
    expect(parsePartnerViewSelection("YouTube")).toBe("youtube");
  });
  it("garbage, all, empty, other platforms, non-strings and repeated params are All", () => {
    for (const raw of ["all", "", "   ", "tiktok", "insta", "definitely-not", undefined, null, 42, ["instagram", "youtube"], ["instagram"], {}]) {
      expect(parsePartnerViewSelection(raw), String(raw)).toBe("all");
    }
  });
  it("All includes both platforms; a single selection includes only itself", () => {
    expect(platformsForSelection("all")).toEqual(["instagram", "youtube"]);
    expect(platformsForSelection("youtube")).toEqual(["youtube"]);
  });
});

describe("aggregatePartnerKpis - All vs single platform", () => {
  const records = [
    content({ platform: "instagram", views: 1000, likes: 100, comments: 10, engagement: 55 }),
    content({ platform: "instagram", views: null, likes: 50, comments: null, engagement: null }),
    content({ platform: "youtube", views: 7000, likes: null, comments: 70, engagement: 500 }),
  ];

  it("Published content totals across platforms (shared unit) with the split", () => {
    const all = aggregatePartnerKpis(records, "all");
    expect(all.publishedContent).toEqual({ total: 3, byPlatform: [{ platform: "instagram", count: 2 }, { platform: "youtube", count: 1 }] });
    expect(aggregatePartnerKpis(records, "instagram").publishedContent).toEqual({ total: 2, byPlatform: [{ platform: "instagram", count: 2 }] });
  });

  it("Views are NEVER combined across platforms on All: no total, the per-platform values are kept", () => {
    const { views } = aggregatePartnerKpis(records, "all");
    expect(views.total).toBeNull();
    expect(views.totalBasis).toBe("not_combined");
    expect(views.byPlatform).toEqual([
      { platform: "instagram", total: 1000, recordsWithValue: 1, recordsTotal: 2 },
      { platform: "youtube", total: 7000, recordsWithValue: 1, recordsTotal: 1 },
    ]);
    expect(JSON.stringify(views)).not.toContain("8000");
  });

  it("Views ARE that platform's own total on a single-platform selection", () => {
    const ig = aggregatePartnerKpis(records, "instagram").views;
    expect(ig).toMatchObject({ total: 1000, totalBasis: "single_platform", recordsWithValue: 1, recordsTotal: 2 });
    expect(ig.byPlatform).toHaveLength(1);
    expect(aggregatePartnerKpis(records, "youtube").views.total).toBe(7000);
  });

  it("Engagement / Likes / Comments use their OWN fields, total across platforms with coverage and the split", () => {
    const k = aggregatePartnerKpis(records, "all");
    // Engagement = source-reported engagement only (55 + 500), never likes + comments.
    expect(k.engagement).toMatchObject({ total: 555, totalBasis: "sum_across_platforms", recordsWithValue: 2, recordsTotal: 3 });
    expect(k.likes).toMatchObject({ total: 150, recordsWithValue: 2, recordsTotal: 3 });
    expect(k.comments).toMatchObject({ total: 80, recordsWithValue: 2, recordsTotal: 3 });
    expect(k.engagement.byPlatform.map((e) => [e.platform, e.total])).toEqual([["instagram", 55], ["youtube", 500]]);
    expect(k.likes.byPlatform.map((e) => [e.platform, e.total])).toEqual([["instagram", 150], ["youtube", null]]);
  });

  it("missing is null, never zero: all-missing, some-missing and a platform with no records", () => {
    const onlyIg = aggregatePartnerKpis([content({ platform: "instagram", views: 10, likes: null, comments: null, engagement: null })], "all");
    expect(onlyIg.likes.total).toBeNull();
    expect(onlyIg.likes.byPlatform).toEqual([
      { platform: "instagram", total: null, recordsWithValue: 0, recordsTotal: 1 },
      { platform: "youtube", total: null, recordsWithValue: 0, recordsTotal: 0 },
    ]);
    const empty = aggregatePartnerKpis([], "all");
    expect(empty.publishedContent.total).toBe(0);
    for (const metric of [empty.views, empty.engagement, empty.likes, empty.comments]) {
      expect(metric.total).toBeNull();
      expect(metric.byPlatform.every((e) => e.total === null)).toBe(true);
    }
  });

  it("a genuinely reported zero stays 0 (distinct from missing)", () => {
    expect(aggregatePartnerKpis([content({ likes: 0 })], "instagram").likes.total).toBe(0);
  });

  it("only the selected platform's records enter a single-platform aggregate (mixed input cannot leak)", () => {
    expect(aggregatePartnerKpis(records, "youtube").publishedContent.total).toBe(1);
    expect(aggregatePartnerKpis(records, "youtube").likes.total).toBeNull();
  });
});

describe("buildPartnerKpiData - the frozen 5-slot row with the split under every KPI", () => {
  const records = [
    content({ platform: "instagram", views: 1000, likes: 100, comments: 10, engagement: 55 }),
    content({ platform: "instagram", views: null, likes: 50, comments: null, engagement: null }),
    content({ platform: "youtube", views: 7000, likes: null, comments: 70, engagement: 500 }),
  ];

  it("exact order, no Reach slot", () => {
    const items = buildPartnerKpiData(aggregatePartnerKpis(records, "all"));
    expect(items.map((i) => i.label)).toEqual(["Published content", "Views", "Engagement", "Likes", "Comments"]);
    expect(items.map((i) => i.label).join(" ")).not.toMatch(/reach/i);
  });

  it("Views on All: headline 'By platform' with the split, no combined number", () => {
    const [, views] = buildPartnerKpiData(aggregatePartnerKpis(records, "all"));
    expect(views).toMatchObject({ value: "By platform" });
    expect(views!.hint).toContain("Instagram 1K");
    expect(views!.hint).toContain("YouTube 7K");
    expect(views!.hint).not.toContain("8K");
  });

  it("Views on a single platform: that platform's total", () => {
    const [, views] = buildPartnerKpiData(aggregatePartnerKpis(records, "youtube"));
    expect(views!.value).toBe("7K");
    expect(views!.hint).toContain("YouTube 7K");
    expect(views!.hint).not.toContain("Instagram");
  });

  it("every KPI shows the split; a platform without a reported value reads Unavailable, never 0", () => {
    const items = buildPartnerKpiData(aggregatePartnerKpis(records, "all"));
    for (const item of items) {
      expect(item.hint, item.label).toContain("Instagram");
      expect(item.hint, item.label).toContain("YouTube");
    }
    const likes = items.find((i) => i.label === "Likes")!;
    expect(likes.hint).toContain("YouTube Unavailable");
    expect(likes.hint).toContain("2 of 3 records");
    expect(likes.value).toBe("150");
    const engagement = items.find((i) => i.label === "Engagement")!;
    expect(engagement.value).toBe("555");
    for (const item of items) expect(item.hint).not.toMatch(/\b0\b/);
  });

  it("nothing reported at all: Unavailable with the split, never a fabricated 0", () => {
    const items = buildPartnerKpiData(aggregatePartnerKpis([], "all"));
    for (const item of items) {
      expect(item.value).toBe("Unavailable");
      expect(item.hint).toContain("Instagram Unavailable");
      expect(item.hint).toContain("YouTube Unavailable");
    }
  });
});

describe("buildPartnerPlatformCards - separate series, never hidden", () => {
  const march = { start: "2026-03-01", end: "2026-03-31" };
  const april = { start: "2026-04-01", end: "2026-04-30" };

  it("one card per included platform with its OWN series; a platform with no data is an explicit no-data card", () => {
    const records = [
      content({ platform: "instagram", views: 100, reportingPeriod: march }),
      content({ platform: "instagram", views: 300, reportingPeriod: april }),
    ];
    const cards = buildPartnerPlatformCards(records, "all");
    expect(cards.map((c) => [c.platform, c.hasData, c.recordCount])).toEqual([["instagram", true, 2], ["youtube", false, 0]]);
    expect(cards[0]!.trend.series.map((s) => [s.metric, s.values])).toEqual([["views", [100, 300]]]);
    expect(cards[1]!.trend).toEqual({ periods: [], series: [], omittedMetrics: [] });
  });

  it("a single-platform selection yields only that platform's card; gaps stay null, never zero", () => {
    const records = [
      content({ platform: "youtube", views: 5, likes: 1, reportingPeriod: march }),
      content({ platform: "youtube", views: null, likes: 2, reportingPeriod: april }),
      content({ platform: "youtube", views: 9, likes: 3, reportingPeriod: { start: "2026-05-01", end: "2026-05-31" } }),
      content({ platform: "instagram", views: 999_999, reportingPeriod: march }),
    ];
    const cards = buildPartnerPlatformCards(records, "youtube");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.trend.series.find((s) => s.metric === "views")!.values).toEqual([5, null, 9]);
    expect(JSON.stringify(cards)).not.toContain("999999");
  });

  it("Instagram and YouTube points are never merged into one line", () => {
    const records = [
      content({ platform: "instagram", views: 10, reportingPeriod: march }),
      content({ platform: "instagram", views: 20, reportingPeriod: april }),
      content({ platform: "youtube", views: 1000, reportingPeriod: march }),
      content({ platform: "youtube", views: 2000, reportingPeriod: april }),
    ];
    const [ig, yt] = buildPartnerPlatformCards(records, "all");
    expect(ig!.trend.series[0]!.values).toEqual([10, 20]);
    expect(yt!.trend.series[0]!.values).toEqual([1000, 2000]);
  });
});

describe("derivePartnerReportingPeriod", () => {
  it("empty -> No source data yet", () => {
    expect(derivePartnerReportingPeriod([])).toMatchObject({ label: "No source data yet", start: null, end: null, recordsTotal: 0 });
  });
  it("the span is the earliest start .. latest end among records that have a period", () => {
    const period = derivePartnerReportingPeriod([
      { reportingPeriod: { start: "2026-03-01", end: "2026-03-31" } },
      { reportingPeriod: { start: "2026-01-01", end: "2026-01-31" } },
      { reportingPeriod: { start: "2026-02-01", end: "2026-04-30" } },
    ]);
    expect(period).toMatchObject({ start: "2026-01-01", end: "2026-04-30", recordsWithoutPeriod: 0 });
    expect(period.label).toBe("All available imported periods: 2026-01-01 – 2026-04-30");
  });
  it("discloses records that carry no reporting period", () => {
    const period = derivePartnerReportingPeriod([{ reportingPeriod: { start: "2026-03-01", end: "2026-03-31" } }, { reportingPeriod: null }, { reportingPeriod: null }]);
    expect(period.recordsWithoutPeriod).toBe(2);
    expect(period.label).toBe("All available imported periods: 2026-03-01 – 2026-03-31 · No reporting period on 2 records");
    expect(derivePartnerReportingPeriod([{ reportingPeriod: null }]).label).toBe("All available imported periods · No reporting period on 1 record");
  });
});

describe("selectTopContent - one explicit basis, never blended", () => {
  it("basis is Views when any record has a Views value; ranked only among records that HAVE it, descending", () => {
    const records = [
      content({ platform: "instagram", views: 10, engagement: 9999 }),
      content({ platform: "instagram", views: 30 }),
      content({ platform: "instagram", views: null, engagement: 50_000 }), // no Views: not ranked by Views
      content({ platform: "instagram", views: 20 }),
    ];
    const top = selectTopContent(records, "instagram");
    expect(top.basis).toBe("views");
    expect(top.groups).toHaveLength(1);
    expect(top.groups[0]!.records.map((r) => r.views)).toEqual([30, 20, 10]);
    expect(topContentNote(top.basis, "instagram")).toContain("Ranked by Views");
  });

  it("on All, ranks WITHIN each platform (no cross-platform ordering / normalization)", () => {
    const records = [
      content({ platform: "instagram", views: 5 }),
      content({ platform: "instagram", views: 8 }),
      content({ platform: "youtube", views: 5_000_000 }),
      content({ platform: "youtube", views: 4_000_000 }),
    ];
    const top = selectTopContent(records, "all");
    expect(top.groups.map((g) => [g.platform, g.records.map((r) => r.views)])).toEqual([
      ["instagram", [8, 5]],
      ["youtube", [5_000_000, 4_000_000]],
    ]);
    expect(topContentNote(top.basis, "all")).toMatch(/within each platform/);
  });

  it("falls back to Engagement ONLY when no record has Views - and says so", () => {
    const records = [
      content({ platform: "instagram", views: null, engagement: 10, likes: 9999 }),
      content({ platform: "instagram", views: null, engagement: 40 }),
      content({ platform: "instagram", views: null, engagement: null, likes: 1_000_000 }), // likes never substitutes
    ];
    const top = selectTopContent(records, "instagram");
    expect(top.basis).toBe("engagement");
    expect(top.groups[0]!.records.map((r) => r.engagement)).toEqual([40, 10]);
    expect(topContentNote(top.basis, "instagram")).toContain("Ranked by Engagement (no Views reported)");
  });

  it("neither Views nor Engagement -> nothing ranked, neutral note", () => {
    const top = selectTopContent([content({ likes: 5, comments: 5 })], "all");
    expect(top).toEqual({ basis: "none", groups: [] });
    expect(topContentNote("none", "all")).toBe("No content with reported Views or Engagement");
    expect(selectTopContent([], "all").basis).toBe("none");
  });

  it("does not silently switch basis per platform: a platform with no Views under a Views basis has an empty group", () => {
    const records = [content({ platform: "instagram", views: 10 }), content({ platform: "youtube", views: null, engagement: 500 })];
    const top = selectTopContent(records, "all");
    expect(top.basis).toBe("views");
    expect(top.groups.find((g) => g.platform === "youtube")!.records).toEqual([]);
  });

  it("deterministic tie-break: equal metric -> newest posted, then newest imported, then sourceRef; bounded to 5", () => {
    const records = [
      content({ sourceRef: "b", views: 100, postDateTimeIso: "2026-01-01T00:00:00.000Z" }),
      content({ sourceRef: "a", views: 100, postDateTimeIso: "2026-01-01T00:00:00.000Z" }),
      content({ sourceRef: "c", views: 100, postDateTimeIso: "2026-02-01T00:00:00.000Z" }),
      content({ sourceRef: "d", views: 100, postDateTimeIso: null }),
      content({ sourceRef: "e", views: 100, postDateTimeIso: "2025-12-01T00:00:00.000Z" }),
      content({ sourceRef: "f", views: 100, postDateTimeIso: "2025-11-01T00:00:00.000Z" }),
    ];
    const first = selectTopContent(records, "instagram").groups[0]!.records.map((r) => r.sourceRef);
    const second = selectTopContent([...records].reverse(), "instagram").groups[0]!.records.map((r) => r.sourceRef);
    expect(first).toEqual(["c", "a", "b", "e", "f"]); // newest first; equal dates by sourceRef; null date last (and cut by the bound)
    expect(second).toEqual(first);
  });

  it("only the selected platform's records are ranked", () => {
    const top = selectTopContent([content({ platform: "instagram", views: 10 }), content({ platform: "youtube", views: 999_999 })], "instagram");
    expect(top.groups.map((g) => g.platform)).toEqual(["instagram"]);
    expect(top.groups[0]!.records.map((r) => r.views)).toEqual([10]);
  });
});

describe("selectPartnerAccounts - one row per canonical account, never summed", () => {
  it("two accounts on ONE platform stay distinct rows; identity is the account ref, not a name", () => {
    const rows = selectPartnerAccounts(
      [content({ platform: "instagram", matchedPartnerAccountRef: "acct-1" }), content({ platform: "instagram", matchedPartnerAccountRef: "acct-2" }), content({ platform: "instagram", matchedPartnerAccountRef: "acct-2" })],
      [
        channel({ platform: "instagram", matchedPartnerAccountRef: "acct-1", profileFollowers: 5000 }),
        channel({ platform: "instagram", matchedPartnerAccountRef: "acct-2", profileFollowers: 300 }),
      ],
      "all",
    );
    expect(rows.map((r) => r.partnerAccountRef).sort()).toEqual(["acct-1", "acct-2"]);
    expect(rows.find((r) => r.partnerAccountRef === "acct-1")).toMatchObject({ platform: "instagram", contentRecords: 1, channelRecords: 1 });
    expect(rows.find((r) => r.partnerAccountRef === "acct-2")).toMatchObject({ contentRecords: 2, channelRecords: 1 });
    expect(rows.map((r) => r.snapshot?.profileFollowers).sort()).toEqual([300, 5000]);
  });

  it("takes each account's LATEST verified snapshot; an account linked only through content has no snapshot (Unavailable)", () => {
    const rows = selectPartnerAccounts(
      [content({ platform: "youtube", matchedPartnerAccountRef: "yt-only" })],
      [
        channel({ platform: "youtube", matchedPartnerAccountRef: "yt-1", profileFollowers: 100, reportingPeriod: { start: "2026-01-01", end: "2026-01-31" } }),
        channel({ platform: "youtube", matchedPartnerAccountRef: "yt-1", profileFollowers: 150, reportingPeriod: { start: "2026-02-01", end: "2026-02-28" } }),
      ],
      "all",
    );
    expect(rows.find((r) => r.partnerAccountRef === "yt-1")).toMatchObject({ snapshotCount: 2 });
    expect(rows.find((r) => r.partnerAccountRef === "yt-1")!.snapshot!.profileFollowers).toBe(150);
    expect(rows.find((r) => r.partnerAccountRef === "yt-only")!.snapshot).toBeNull();
  });

  it("respects the platform selection and ignores unmatched / account-less records", () => {
    const rows = selectPartnerAccounts(
      [content({ platform: "instagram", matchedPartnerAccountRef: "ig-1" }), content({ platform: "youtube", matchedPartnerAccountRef: "yt-1" }), content({ platform: "youtube", matchedPartnerAccountRef: null })],
      [channel({ platform: "youtube", matchState: "UNMATCHED", matchedPartnerAccountRef: null, profileFollowers: 42 })],
      "youtube",
    );
    expect(rows.map((r) => r.partnerAccountRef)).toEqual(["yt-1"]);
  });
});

describe("buildPartnerSourceQuality", () => {
  const records = [
    content({ platform: "instagram", matchedPartnerAccountRef: "ig-1", views: 1, likes: 1, comments: 1, engagement: 1, createdAt: "2026-05-01T00:00:00.000Z" }),
    content({ platform: "instagram", matchedPartnerAccountRef: null, views: null, createdAt: "2026-06-01T00:00:00.000Z" }),
    content({ platform: "youtube", matchedPartnerAccountRef: "yt-1", views: 5, createdAt: "2026-04-01T00:00:00.000Z" }),
  ];
  const channels = [
    channel({ platform: "instagram", matchedPartnerAccountRef: "ig-1", profileFollowers: 10, createdAt: "2026-03-01T00:00:00.000Z" }),
    channel({ platform: "youtube", matchedPartnerAccountRef: null, profileFollowers: null, createdAt: "2026-07-01T00:00:00.000Z" }),
  ];

  it("merges per-platform 12D quality: counts, per-metric missing, freshest, account coverage", () => {
    const accounts = selectPartnerAccounts(records, channels, "all");
    const quality = buildPartnerSourceQuality(records, channels, "all", accounts);
    expect(quality.content).toEqual({ total: 3, linked: 3, unlinked: 0, ambiguous: 0, withoutAccount: 1 });
    expect(quality.channel).toEqual({ total: 2, linked: 2, unlinked: 0, ambiguous: 0, withoutAccount: 1 });
    const missing = (metric: string) => quality.missingMetrics.find((m) => m.metric === metric)!;
    expect(missing("views")).toMatchObject({ kind: "content", missing: 1, total: 3 });
    expect(missing("profileFollowers")).toMatchObject({ kind: "channel", missing: 1, total: 2 });
    expect(quality.freshness).toEqual({ latestContentAt: "2026-06-01T00:00:00.000Z", latestChannelAt: "2026-07-01T00:00:00.000Z", latestAt: "2026-07-01T00:00:00.000Z" });
    expect(quality.accountCoverage).toEqual({ accountsTotal: 2, accountsWithSnapshots: 1, recordsWithoutAccount: 2 });
  });

  it("empty input: No source data (total 0), never zero performance", () => {
    const quality = buildPartnerSourceQuality([], [], "all", []);
    expect(quality.content.total).toBe(0);
    expect(quality.freshness).toEqual({ latestContentAt: null, latestChannelAt: null, latestAt: null });
    expect(quality.accountCoverage).toEqual({ accountsTotal: 0, accountsWithSnapshots: 0, recordsWithoutAccount: 0 });
  });

  it("a single-platform selection counts only that platform", () => {
    const accounts = selectPartnerAccounts(records, channels, "youtube");
    const quality = buildPartnerSourceQuality(records, channels, "youtube", accounts);
    expect(quality.content.total).toBe(1);
    expect(quality.channel.total).toBe(1);
  });
});
