import { describe, expect, it } from "vitest";

import { channelRecord, contentRecord, month } from "./partners-workspace-fixtures";
import {
  availableMonthsOf,
  buildComparisonRow,
  buildMonthlyPartnerPlatformCards,
  buildMonthlyPlatformTrend,
  buildTrendMatrices,
  coverageStateOf,
  coverageSummaryText,
  exclusionsOf,
  latestChannelSnapshot,
  latestMonthOf,
  restrictWindowToSelection,
  type PartnerRecordWindow,
} from "./partners-workspace-metrics";

const window = (content: PartnerRecordWindow["content"] = [], channel: PartnerRecordWindow["channel"] = [], truncated = false): PartnerRecordWindow => ({ content, channel, truncated });

function rowFor(w: PartnerRecordWindow, m: string | null, selection: "all" | "instagram" | "youtube" = "all", displayName = "Partner") {
  return buildComparisonRow({ displayName, analyticsHref: `/analytics/partner/x?month=${m}`, window: w, month: m, selection });
}

describe("coverage state and the x-of-y sentence", () => {
  it("state follows the in-month kinds present", () => {
    expect(coverageStateOf(2, 1)).toBe("content_and_channel");
    expect(coverageStateOf(2, 0)).toBe("content_only");
    expect(coverageStateOf(0, 3)).toBe("channel_only");
    expect(coverageStateOf(0, 0)).toBe("no_data");
  });
  it("reads '4 of 6 selected Partners have Analytics data for August 2026' and adjusts number / platform", () => {
    expect(coverageSummaryText({ selected: 6, withData: 4, month: "2026-08", platform: "all" })).toBe("4 of 6 selected Partners have Analytics data for August 2026");
    expect(coverageSummaryText({ selected: 1, withData: 1, month: "2026-08", platform: "all" })).toBe("1 of 1 selected Partner has Analytics data for August 2026");
    expect(coverageSummaryText({ selected: 3, withData: 1, month: "2026-08", platform: "youtube" })).toBe("1 of 3 selected Partners has YouTube Analytics data for August 2026");
    expect(coverageSummaryText({ selected: 3, withData: 0, month: "2026-07", platform: "all" })).toBe("0 of 3 selected Partners have Analytics data for July 2026");
    expect(coverageSummaryText({ selected: 1, withData: 0, month: "2026-07", platform: "all" })).toBe("0 of 1 selected Partner has Analytics data for July 2026");
  });
});

describe("month availability and exclusions over windows", () => {
  const w1 = window([contentRecord({ reportingPeriod: month("2019-03") }), contentRecord({ reportingPeriod: null })], [channelRecord({ reportingPeriod: month("2019-04") })]);
  const w2 = window([contentRecord({ reportingPeriod: { start: "2019-05-01", end: "2019-06-30" } }), contentRecord({ reportingPeriod: { start: "x", end: "y" } })], []);
  it("months come from the union of every window's own periods, newest first", () => {
    expect(availableMonthsOf([w1, w2])).toEqual(["2019-04", "2019-03"]);
  });
  it("records that cannot be placed in a month are counted per reason across windows", () => {
    expect(exclusionsOf([w1, w2])).toEqual({ noPeriod: 1, unparseable: 1, spans: 1 });
  });
  it("a window is restricted to the selected platforms (belt and braces)", () => {
    const mixed = window([contentRecord({ platform: "instagram" }), contentRecord({ platform: "youtube" }), contentRecord({ platform: "tiktok" })], [channelRecord({ platform: "youtube" })]);
    const ig = restrictWindowToSelection(mixed, "instagram");
    expect(ig.content.map((r) => r.platform)).toEqual(["instagram"]);
    expect(ig.channel).toEqual([]);
    expect(restrictWindowToSelection(mixed, "all").content.map((r) => r.platform)).toEqual(["instagram", "youtube"]);
  });
});

describe("comparison row - each Partner from its OWN in-month records", () => {
  const A = window([
    contentRecord({ platform: "instagram", views: 1000, engagement: 55, likes: 100, comments: 10, reportingPeriod: month("2026-08") }),
    contentRecord({ platform: "instagram", views: 500, engagement: null, likes: 50, comments: null, reportingPeriod: month("2026-08") }),
    contentRecord({ platform: "youtube", views: 7000, engagement: 700, likes: 70, comments: 7, reportingPeriod: month("2026-08") }),
    contentRecord({ platform: "instagram", views: 999_999, engagement: 999_999, likes: 999_999, comments: 999_999, reportingPeriod: month("2026-07") }), // other month
  ]);
  const B = window([contentRecord({ platform: "instagram", views: 3, engagement: null, likes: null, comments: null, reportingPeriod: month("2026-08") })]);
  const C = window([contentRecord({ platform: "instagram", views: 12345, reportingPeriod: month("2026-07") })]); // nothing in August

  it("Instagram and YouTube Views are separate native columns, never combined", () => {
    const row = rowFor(A, "2026-08");
    expect(row.instagramViews).toEqual({ total: 1500, recordsWithValue: 2, recordsTotal: 2 });
    expect(row.youtubeViews).toEqual({ total: 7000, recordsWithValue: 1, recordsTotal: 1 });
    expect(JSON.stringify(row)).not.toMatch(/8500/); // 1500 + 7000 is never a value anywhere
  });
  it("engagement / likes / comments are source-reported sums across the platform selection with x of y coverage", () => {
    const row = rowFor(A, "2026-08");
    expect(row.engagement).toEqual({ total: 755, recordsWithValue: 2, recordsTotal: 3 });
    expect(row.likes).toEqual({ total: 220, recordsWithValue: 3, recordsTotal: 3 });
    expect(row.comments).toEqual({ total: 17, recordsWithValue: 2, recordsTotal: 3 });
    expect(row.publishedContent).toBe(3);
  });
  it("only the selected month counts (the July record never leaks into August)", () => {
    const aug = rowFor(A, "2026-08");
    const jul = rowFor(A, "2026-07");
    expect(JSON.stringify(aug)).not.toContain("999999");
    expect(jul.instagramViews?.total).toBe(999_999);
    expect(jul.youtubeViews).toEqual({ total: null, recordsWithValue: 0, recordsTotal: 0 });
  });
  it("partners are independent: adding another Partner changes nothing in this row", () => {
    expect(rowFor(A, "2026-08")).toEqual(rowFor(A, "2026-08"));
    const rows = [A, B, C].map((w) => rowFor(w, "2026-08"));
    expect(rows[0]).toEqual(rowFor(A, "2026-08"));
    expect(rows[1]!.instagramViews).toEqual({ total: 3, recordsWithValue: 1, recordsTotal: 1 });
  });
  it("missing is null / Unavailable - NEVER zero", () => {
    const b = rowFor(B, "2026-08");
    expect(b.engagement).toEqual({ total: null, recordsWithValue: 0, recordsTotal: 1 });
    expect(b.likes.total).toBeNull();
    expect(b.comments.total).toBeNull();
    const c = rowFor(C, "2026-08");
    expect(c.coverage.state).toBe("no_data");
    expect(c.publishedContent).toBeNull();
    expect(c.instagramViews).toEqual({ total: null, recordsWithValue: 0, recordsTotal: 0 });
    expect(c.engagement).toEqual({ total: null, recordsWithValue: 0, recordsTotal: 0 });
    for (const cell of [c.instagramViews, c.youtubeViews, c.engagement, c.likes, c.comments]) expect(cell?.total).not.toBe(0);
  });
  it("a Partner with no data stays a row with a visible coverage state", () => {
    const c = rowFor(C, "2026-08", "all", "Ghost Partner");
    expect(c).toMatchObject({ displayName: "Ghost Partner", coverage: { state: "no_data", label: "Unavailable", contentRecords: 0, channelRecords: 0 } });
  });
  it("no resolved month: everything is no data", () => {
    const row = rowFor(A, null);
    expect(row.coverage.state).toBe("no_data");
    expect(row.publishedContent).toBeNull();
  });
  it("a platform filter removes the other platform from the row (its Views column is absent, its records never counted)", () => {
    const ig = rowFor(A, "2026-08", "instagram");
    expect(ig.youtubeViews).toBeNull();
    expect(ig.instagramViews).toEqual({ total: 1500, recordsWithValue: 2, recordsTotal: 2 });
    expect(ig.publishedContent).toBe(2);
    expect(ig.engagement).toEqual({ total: 55, recordsWithValue: 1, recordsTotal: 2 });
    const yt = rowFor(A, "2026-08", "youtube");
    expect(yt.instagramViews).toBeNull();
    expect(yt.youtubeViews?.total).toBe(7000);
  });
  it("channel-only data is disclosed as such (a follower snapshot is not content performance)", () => {
    const only = rowFor(window([], [channelRecord({ reportingPeriod: month("2026-08") })]), "2026-08");
    expect(only.coverage).toMatchObject({ state: "channel_only", contentRecords: 0, channelRecords: 1 });
    expect(only.publishedContent).toBeNull();
  });
  it("carries the truncation flag of the Partner's own window", () => {
    expect(rowFor(window([contentRecord({ reportingPeriod: month("2026-08") })], [], true), "2026-08").coverage.truncated).toBe(true);
    expect(rowFor(A, "2026-08").coverage.truncated).toBe(false);
  });
});

describe("latest channel snapshot - a freshness indicator, never a follower total", () => {
  it("is the most recently IMPORTED snapshot with its period; deterministic tie-break; null without channel records", () => {
    const old = channelRecord({ createdAt: "2026-05-01T00:00:00.000Z", reportingPeriod: month("2026-04"), profileFollowers: 111 });
    const fresh = channelRecord({ createdAt: "2026-07-01T00:00:00.000Z", reportingPeriod: month("2026-06"), profileFollowers: 222 });
    expect(latestChannelSnapshot([old, fresh])).toEqual({ importedAt: "2026-07-01T00:00:00.000Z", reportingPeriod: month("2026-06") });
    expect(latestChannelSnapshot([])).toBeNull();
    expect(JSON.stringify(latestChannelSnapshot([old, fresh]))).not.toMatch(/222|111|ollowers/);
  });
  it("is independent of the selected month (freshness of the Partner's data overall)", () => {
    const snap = channelRecord({ createdAt: "2026-07-01T00:00:00.000Z", reportingPeriod: month("2026-06") });
    expect(rowFor(window([], [snap]), "2026-08").latestSnapshot?.importedAt).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("monthly platform trend - gaps stay gaps", () => {
  const records = [
    contentRecord({ platform: "instagram", views: 100, likes: 10, engagement: 5, comments: null, reportingPeriod: month("2026-03") }),
    contentRecord({ platform: "instagram", views: 50, likes: null, engagement: 4, comments: null, reportingPeriod: month("2026-03") }),
    // 2026-04 missing entirely -> a gap
    contentRecord({ platform: "instagram", views: 300, likes: 30, engagement: null, comments: 3, reportingPeriod: month("2026-05") }),
    contentRecord({ platform: "instagram", views: 700, likes: 70, engagement: 9, comments: null, reportingPeriod: month("2026-06") }),
    // not placeable in any month: never contributes
    contentRecord({ platform: "instagram", views: 99_999, reportingPeriod: null }),
    contentRecord({ platform: "instagram", views: 88_888, reportingPeriod: { start: "2026-03-15", end: "2026-04-15" } }),
    // another platform: never in the Instagram series
    contentRecord({ platform: "youtube", views: 77_777, reportingPeriod: month("2026-05") }),
  ];
  const trend = buildMonthlyPlatformTrend(records, "instagram", "2026-06");

  it("uses a continuous calendar axis, keeps the missing month as a null gap and trims leading/trailing empty months", () => {
    expect(trend.periods.map((p) => p.label)).toEqual(["Mar 2026", "Apr 2026", "May 2026", "Jun 2026"]);
    const views = trend.series.find((s) => s.metric === "views")!;
    expect(views.values).toEqual([150, null, 300, 700]);
  });
  it("never zero-fills or interpolates", () => {
    for (const series of trend.series) for (const value of series.values) expect(value === null || value > 0).toBe(true);
    expect(trend.series.find((s) => s.metric === "views")!.values[1]).toBeNull();
  });
  it("excludes no-period / spanning records and other platforms", () => {
    expect(JSON.stringify(trend)).not.toMatch(/99999|88888|77777/);
  });
  it("a metric reported in fewer than two months is not plotted and is disclosed", () => {
    expect(trend.series.map((s) => s.metric)).toEqual(["views", "engagement", "likes"]);
    expect(trend.omittedMetrics).toEqual(["comments"]);
    expect(trend.series.find((s) => s.metric === "engagement")!.values).toEqual([9, null, null, 9]);
    expect(trend.series.find((s) => s.metric === "likes")!.values).toEqual([10, null, 30, 70]);
  });
  it("no axis end / no monthly data yields an empty trend", () => {
    expect(buildMonthlyPlatformTrend(records, "instagram", null)).toEqual({ periods: [], series: [], omittedMetrics: [] });
    expect(buildMonthlyPlatformTrend([], "instagram", "2026-06").series).toEqual([]);
  });
  it("is bounded to a 12-month window ending at the axis end", () => {
    const old = contentRecord({ platform: "instagram", views: 1, reportingPeriod: month("2024-01") });
    const t = buildMonthlyPlatformTrend([old, contentRecord({ platform: "instagram", views: 2, reportingPeriod: month("2026-05") }), contentRecord({ platform: "instagram", views: 3, reportingPeriod: month("2026-06") })], "instagram", "2026-06");
    expect(t.periods.length).toBeLessThanOrEqual(12);
    expect(t.periods.map((p) => p.label)).not.toContain("Jan 2024");
  });
  it("month cards: one per included platform on the SAME axis, a platform without data is still a card, series never merged", () => {
    const cards = buildMonthlyPartnerPlatformCards(records, "all");
    expect(cards.map((c) => c.platform)).toEqual(["instagram", "youtube"]);
    expect(cards.every((c) => c.trendBasis === "month")).toBe(true);
    expect(cards[1]!.hasData).toBe(true);
    expect(cards[1]!.trend.series).toEqual([]); // one YouTube month only
    const igOnly = buildMonthlyPartnerPlatformCards(records.filter((r) => r.platform === "instagram"), "all");
    expect(igOnly[1]).toMatchObject({ platform: "youtube", hasData: false, recordCount: 0 });
  });
  it("latestMonthOf ignores unplaceable records", () => {
    expect(latestMonthOf(records)).toBe("2026-06");
    expect(latestMonthOf([contentRecord({ reportingPeriod: null })])).toBeNull();
  });
});

describe("month x Partner matrix - one metric at a time, never blended across Partners", () => {
  const P1 = { displayName: "Alpha", window: window([contentRecord({ platform: "instagram", views: 10, engagement: 1, reportingPeriod: month("2026-07") }), contentRecord({ platform: "youtube", views: 20, engagement: 2, reportingPeriod: month("2026-07") }), contentRecord({ platform: "instagram", views: 30, engagement: null, reportingPeriod: month("2026-08") })]) };
  const P2 = { displayName: "Beta", window: window([contentRecord({ platform: "instagram", views: 5, engagement: 4, reportingPeriod: month("2026-08") })]) };
  const months = ["2026-08", "2026-07"];

  it("Views on All are two SEPARATE matrices (never combined)", () => {
    const matrices = buildTrendMatrices({ partners: [P1, P2], selection: "all", metric: "views", months });
    expect(matrices.map((m) => [m.platform, m.title])).toEqual([["instagram", "Instagram Views"], ["youtube", "YouTube Views"]]);
    expect(matrices[0]!.months.map((m) => m.month)).toEqual(["2026-07", "2026-08"]); // chronological
    expect(matrices[0]!.cells).toEqual([[10, null], [30, 5]]);
    expect(matrices[1]!.cells).toEqual([[20, null], [null, null]]);
    expect(JSON.stringify(matrices)).not.toContain("30,5,20"); // no cross-platform merge
  });
  it("other metrics are one matrix over the platform selection; missing cells are null (never 0)", () => {
    const [matrix] = buildTrendMatrices({ partners: [P1, P2], selection: "all", metric: "engagement", months });
    expect(matrix).toMatchObject({ platform: null, title: "Engagement (all platforms)" });
    expect(matrix!.cells).toEqual([[3, null], [null, 4]]);
  });
  it("a single-platform selection filters the matrix to that platform", () => {
    const [matrix] = buildTrendMatrices({ partners: [P1], selection: "youtube", metric: "engagement", months });
    expect(matrix!.title).toBe("YouTube Engagement");
    expect(matrix!.cells).toEqual([[2], [null]]);
    const views = buildTrendMatrices({ partners: [P1], selection: "instagram", metric: "views", months });
    expect(views).toHaveLength(1);
  });
  it("each cell belongs to ONE Partner and month - there is no total row / column", () => {
    const [matrix] = buildTrendMatrices({ partners: [P1, P2], selection: "instagram", metric: "views", months });
    expect(matrix!.partners.map((p) => p.displayName)).toEqual(["Alpha", "Beta"]);
    expect(matrix!.cells.every((row) => row.length === 2)).toBe(true);
  });
  it("is bounded by what the caller passes (<= 12 months x <= 10 Partners) and tolerates no months", () => {
    expect(buildTrendMatrices({ partners: [P1], selection: "all", metric: "likes", months: [] })[0]!.cells).toEqual([]);
  });
});

describe("no scoring / blending / follower-total / unsupported-metric keys anywhere in the comparison shapes", () => {
  const FORBIDDEN_KEY = /score|rating|rank|weight|composite|blend|overall|combined|reach|impression|watch|share|save|followerTotal|totalFollowers|growth|estimate|tier/i;
  function keysOf(value: unknown, path = ""): string[] {
    if (Array.isArray(value)) return value.flatMap((item) => keysOf(item, path));
    if (value && typeof value === "object") return Object.entries(value).flatMap(([key, child]) => [`${path}.${key}`, ...keysOf(child, `${path}.${key}`)]);
    return [];
  }
  it("row and matrix keys are free of forbidden vocabulary", () => {
    const w = window([contentRecord({ reportingPeriod: month("2026-08") }), contentRecord({ platform: "youtube", reportingPeriod: month("2026-08") })], [channelRecord({ reportingPeriod: month("2026-08") })]);
    const row = rowFor(w, "2026-08");
    const matrices = buildTrendMatrices({ partners: [{ displayName: "A", window: w }], selection: "all", metric: "views", months: ["2026-08"] });
    for (const key of keysOf([row, matrices])) expect(key, key).not.toMatch(FORBIDDEN_KEY);
  });
  it("no raw ref / uid / url is present in a comparison row", () => {
    const w = window([contentRecord({ matchedPartnerAccountRef: "account-ref-secret", matchedCampaignRef: "campaign-ref-secret", reportingPeriod: month("2026-08") })], [channelRecord({ reportingPeriod: month("2026-08") })]);
    const json = JSON.stringify(rowFor(w, "2026-08"));
    for (const secret of ["uid-secret", "SRC-SECRET", "batch-secret", "account-ref-secret", "campaign-ref-secret", "RAW CAPTION", "RAW-URL", "raw_user_secret", "https://", "partner-secret-1"]) expect(json, secret).not.toContain(secret);
  });
});
