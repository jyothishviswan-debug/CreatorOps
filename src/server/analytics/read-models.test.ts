import { describe, expect, it } from "vitest";

import { aggregateFreshnessByPlatform, aggregateIngestionExceptionCounts, aggregateInteractionsByPlatform, aggregatePlatformTotals, aggregateSourceRecordCountsByPlatform, rankPartnersByMetric } from "./read-models";
import type { AnalyticsContentSourceRecordDoc } from "./types";

// Step 12A section 14: these are pure functions over an ALREADY scope-
// constrained, plain array - no Firestore, no scope logic of their own -
// exactly what makes them safe unit-test targets. Builds minimal but
// schema-shaped fixtures directly (a query-time aggregation function,
// not the persistence layer, so a loosely-typed cast is acceptable here).
function contentRecord(overrides: Partial<AnalyticsContentSourceRecordDoc>): AnalyticsContentSourceRecordDoc {
  return {
    uid: "r1",
    sourceRef: "r1",
    batchRef: "b1",
    sheetName: "Sheet1",
    sourceRowNumber: 2,
    platform: "instagram",
    rowIdentityKey: "key",
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
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("aggregatePlatformTotals - supported metrics only, missing never becomes zero", () => {
  it("sums non-null values per platform per metric", () => {
    const totals = aggregatePlatformTotals([contentRecord({ platform: "instagram", comments: 10, likes: 20 }), contentRecord({ platform: "instagram", comments: 5, likes: null })]);
    expect(totals.instagram!.comments).toBe(15);
    expect(totals.instagram!.likes).toBe(20);
  });

  it("a metric never once reported for a platform stays null, not 0", () => {
    const totals = aggregatePlatformTotals([contentRecord({ platform: "youtube", comments: null, likes: null, views: null, profileFollowers: null, engagement: null })]);
    expect(totals.youtube!.comments).toBeNull();
    expect(totals.youtube!.likes).toBeNull();
  });

  it("never mixes two different platforms' totals together", () => {
    const totals = aggregatePlatformTotals([contentRecord({ platform: "instagram", likes: 100 }), contentRecord({ platform: "youtube", likes: 5 })]);
    expect(totals.instagram!.likes).toBe(100);
    expect(totals.youtube!.likes).toBe(5);
  });
});

describe("aggregateSourceRecordCountsByPlatform", () => {
  it("counts records per platform", () => {
    const counts = aggregateSourceRecordCountsByPlatform([{ platform: "instagram" }, { platform: "instagram" }, { platform: "youtube" }]);
    expect(counts).toEqual({ instagram: 2, youtube: 1 });
  });
});

describe("aggregateInteractionsByPlatform - never a blended score, never Shares", () => {
  it("sums comments+likes only when BOTH are source-reported on the same row", () => {
    const totals = aggregateInteractionsByPlatform([contentRecord({ platform: "instagram", comments: 10, likes: 20 }), contentRecord({ platform: "instagram", comments: 5, likes: null })]);
    // Second row contributes nothing (likes missing) - never treated as +5+0.
    expect(totals.instagram).toBe(30);
  });

  it("is null for a platform where no row ever had both comments and likes reported", () => {
    const totals = aggregateInteractionsByPlatform([contentRecord({ platform: "instagram", comments: 10, likes: null })]);
    expect(totals.instagram).toBeNull();
  });
});

describe("rankPartnersByMetric - one metric at a time, never blended", () => {
  it("ranks matched partners by the single selected metric, descending", () => {
    const ranking = rankPartnersByMetric(
      [
        contentRecord({ matchedPartnerRef: "partner-a", likes: 100 }),
        contentRecord({ matchedPartnerRef: "partner-b", likes: 500 }),
        contentRecord({ matchedPartnerRef: "partner-a", likes: 50 }),
      ],
      "likes",
    );
    expect(ranking).toEqual([
      { partnerRef: "partner-b", total: 500 },
      { partnerRef: "partner-a", total: 150 },
    ]);
  });

  it("excludes an unmatched record entirely - never ranks a null partnerRef", () => {
    const ranking = rankPartnersByMetric([contentRecord({ matchedPartnerRef: null, likes: 999 })], "likes");
    expect(ranking).toEqual([]);
  });
});

describe("aggregateIngestionExceptionCounts", () => {
  it("counts unmatched and ambiguous separately, from real matchState values", () => {
    const counts = aggregateIngestionExceptionCounts([{ matchState: "MATCHED" }, { matchState: "UNMATCHED" }, { matchState: "UNMATCHED" }, { matchState: "AMBIGUOUS" }]);
    expect(counts).toEqual({ unmatched: 2, ambiguous: 1 });
  });
});

describe("aggregateFreshnessByPlatform", () => {
  it("returns the most recent createdAt per platform", () => {
    const freshness = aggregateFreshnessByPlatform([
      { platform: "instagram", createdAt: "2025-01-01T00:00:00.000Z" },
      { platform: "instagram", createdAt: "2025-03-01T00:00:00.000Z" },
      { platform: "youtube", createdAt: "2025-02-01T00:00:00.000Z" },
    ]);
    expect(freshness.instagram).toBe("2025-03-01T00:00:00.000Z");
    expect(freshness.youtube).toBe("2025-02-01T00:00:00.000Z");
  });
});
