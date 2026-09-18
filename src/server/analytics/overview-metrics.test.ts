import { describe, expect, it } from "vitest";

import {
  buildAvailableDonutSegments,
  buildIngestionExceptionCategories,
  buildPlatformMetricTrend,
  computeCampaignLinkageBadge,
  computeFreshnessBadge,
  computeStaleBatchCount,
  formatPublishedContentHint,
  platformAbbreviation,
  sumMetricAcrossPlatforms,
} from "./overview-metrics";
import type { AnalyticsContentSourceRecordDoc } from "./types";

function record(overrides: Partial<AnalyticsContentSourceRecordDoc>): AnalyticsContentSourceRecordDoc {
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

describe("platformAbbreviation", () => {
  it("maps known platforms", () => {
    expect(platformAbbreviation("instagram")).toBe("IG");
    expect(platformAbbreviation("youtube")).toBe("YT");
    expect(platformAbbreviation("tiktok")).toBe("TT");
  });
  it("falls back to an uppercase prefix for unknown platforms", () => {
    expect(platformAbbreviation("facebook")).toBe("FA");
  });
});

describe("sumMetricAcrossPlatforms", () => {
  it("sums only platforms that reported the metric, stays null when nobody did", () => {
    const totals = { instagram: { likes: 10 }, youtube: { likes: null } };
    expect(sumMetricAcrossPlatforms(totals, "likes")).toEqual({ sum: 10, coveredPlatforms: ["instagram"], missingPlatforms: ["youtube"] });
    expect(sumMetricAcrossPlatforms({ instagram: { views: null }, youtube: { views: null } }, "views").sum).toBeNull();
  });
});

describe("formatPublishedContentHint", () => {
  it("builds a real per-platform breakdown", () => {
    expect(formatPublishedContentHint({ instagram: 389, youtube: 426 })).toBe("389 IG · 426 YT");
  });
  it("handles no data", () => {
    expect(formatPublishedContentHint({})).toBe("No source content records yet");
  });
});

describe("computeStaleBatchCount", () => {
  it("counts only FAILED and COMPLETED_WITH_ERRORS", () => {
    expect(computeStaleBatchCount([{ status: "COMPLETED" }, { status: "FAILED" }, { status: "COMPLETED_WITH_ERRORS" }, { status: "PENDING" }])).toBe(2);
  });
});

describe("computeCampaignLinkageBadge", () => {
  it("is Not started with zero matches", () => expect(computeCampaignLinkageBadge(0, 5)).toBe("Not started"));
  it("is Partial with matches and exceptions", () => expect(computeCampaignLinkageBadge(3, 2)).toBe("Partial"));
  it("is Current with matches and no exceptions", () => expect(computeCampaignLinkageBadge(3, 0)).toBe("Current"));
});

describe("computeFreshnessBadge", () => {
  it("never reads Current for a missing date", () => expect(computeFreshnessBadge(null)).toBe("No data"));
  it("reads Current for any real date", () => expect(computeFreshnessBadge("2020-01-01T00:00:00.000Z")).toBe("Current"));
});

describe("buildAvailableDonutSegments", () => {
  it("omits never-reported metrics but keeps real zeros", () => {
    const result = buildAvailableDonutSegments([
      { label: "Likes", sum: 1020 },
      { label: "Engagement", sum: null },
      { label: "Comments", sum: 0 },
    ]);
    expect(result.segments).toEqual([
      { label: "Likes", value: 1020 },
      { label: "Comments", value: 0 },
    ]);
    expect(result.omittedLabels).toEqual(["Engagement"]);
    expect(result.total).toBe(1020);
  });
});

describe("buildPlatformMetricTrend", () => {
  it("returns null when the platform never reported the metric", () => {
    const records = [record({ platform: "youtube", views: null })];
    expect(buildPlatformMetricTrend(records, "youtube", "views")).toBeNull();
  });

  it("returns null for a single distinct period bucket (avoids TrendGrid's NaN% delta on one point)", () => {
    const records = [record({ platform: "youtube", views: 100, createdAt: "2026-08-01T00:00:00.000Z" }), record({ platform: "youtube", views: 50, createdAt: "2026-08-15T00:00:00.000Z" })];
    // Both records fall into the same YYYY-MM bucket ("2026-08") - still just one point.
    expect(buildPlatformMetricTrend(records, "youtube", "views")).toBeNull();
  });

  it("buckets by reportingPeriod when present, sums within a bucket, sorts chronologically", () => {
    const records = [
      record({ platform: "youtube", views: 100, reportingPeriod: { start: "2026-07-01", end: "2026-07-31" } }),
      record({ platform: "youtube", views: 20, reportingPeriod: { start: "2026-08-01", end: "2026-08-31" } }),
      record({ platform: "youtube", views: 30, reportingPeriod: { start: "2026-07-01", end: "2026-07-31" } }),
    ];
    expect(buildPlatformMetricTrend(records, "youtube", "views")).toEqual([
      { periodLabel: "2026-07-01–2026-07-31", value: 130 },
      { periodLabel: "2026-08-01–2026-08-31", value: 20 },
    ]);
  });

  it("never derives Engagement from likes+comments - reads only the engagement field itself", () => {
    const records = [
      record({ platform: "instagram", likes: 1000, comments: 500, engagement: 7, reportingPeriod: { start: "2026-07-01", end: "2026-07-31" } }),
      record({ platform: "instagram", likes: 2000, comments: 900, engagement: 9, reportingPeriod: { start: "2026-08-01", end: "2026-08-31" } }),
    ];
    expect(buildPlatformMetricTrend(records, "instagram", "engagement")).toEqual([
      { periodLabel: "2026-07-01–2026-07-31", value: 7 },
      { periodLabel: "2026-08-01–2026-08-31", value: 9 },
    ]);
  });
});

describe("buildIngestionExceptionCategories", () => {
  it("includes only categories with a real non-zero count", () => {
    const rows = buildIngestionExceptionCategories({ unmatchedContent: 2, unmatchedChannel: 0, ambiguousTotal: 1, staleBatches: 0 });
    expect(rows.map((r) => r.title)).toEqual(["Unlinked content", "Ambiguous records"]);
  });
  it("is empty when nothing needs review", () => {
    expect(buildIngestionExceptionCategories({ unmatchedContent: 0, unmatchedChannel: 0, ambiguousTotal: 0, staleBatches: 0 })).toEqual([]);
  });
});
