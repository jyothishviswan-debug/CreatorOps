import { describe, expect, it } from "vitest";

import { buildHistoryRows } from "@/server/partner-reviews/partner-history-model";
import { partnerReviewHeadDocSchema } from "@/server/partner-reviews/types";
import { reviewRefFor } from "@/server/partner-reviews/period";
import { summaryFixture } from "../../../tests/fixtures/partner-reviews-ui";

import { buildPlatformTrend, platformsInHistory } from "./history-view-model";

function rowsFor(spec: Array<{ month: string; perPlatform?: Record<string, { views: number | null; engagement: number | null; likes: number | null; comments: number | null }> } | { month: string; none: true }>) {
  const heads = new Map<string, ReturnType<typeof partnerReviewHeadDocSchema.parse>>();
  const displays = new Map<string, { display: never; source: "stored" }>();
  for (const entry of spec) {
    if ("none" in entry) continue;
    const reviewRef = reviewRefFor("p1", entry.month);
    heads.set(
      entry.month,
      partnerReviewHeadDocSchema.parse({ reviewRef, partnerRef: "p1", partnerUid: "u", periodKey: entry.month, periodStart: `${entry.month}-01`, periodEnd: `${entry.month}-28`, latestVersion: 1, latestStatus: "DRAFT", currentFinalizedVersion: null, openVersion: 1, docVersion: 1, createdAt: "2026-04-01T00:00:00.000Z", createdByUserRef: "u", updatedAt: "2026-04-01T00:00:00.000Z", updatedByUserRef: "u" }),
    );
    displays.set(reviewRef, {
      display: { version: 1, status: "DRAFT", summary: summaryFixture({ performance: { perPlatform: entry.perPlatform ?? {} } }), evidenceCutoff: "2026-04-01T00:00:00.000Z", lastEventKind: "generated", lastEventAt: "2026-04-01T00:00:00.000Z", revisionCount: 0, supersededVersion: null, finalizedVersion: null, finalizedAt: null } as never,
      source: "stored",
    });
  }
  return buildHistoryRows({ months: spec.map((entry) => entry.month), heads, displays, candidates: new Map(), partnerDisplayName: "Partner One" });
}

const m = (views: number | null, likes: number | null = null) => ({ views, engagement: null, likes, comments: null });

describe("Partner-wise performance trends keep platforms separate", () => {
  const rows = rowsFor([
    { month: "2026-03", perPlatform: { instagram: m(300, 30), youtube: m(9000) } },
    { month: "2026-02", none: true },
    { month: "2026-01", perPlatform: { instagram: m(100, 10), youtube: m(null) } },
    { month: "2025-12", perPlatform: { instagram: m(200, 20) } },
  ]);

  it("lists platforms with any evidence: Instagram, YouTube (then others), never a combined one", () => {
    expect(platformsInHistory(rows)).toEqual(["instagram", "youtube"]);
  });

  it("builds one PlatformTrend per platform, oldest to newest, with gaps kept as gaps (never zero, never interpolated)", () => {
    const instagram = buildPlatformTrend(rows, "instagram");
    expect(instagram.periods.map((period) => period.key)).toEqual(["2025-12", "2026-01", "2026-02", "2026-03"]);
    const views = instagram.series.find((series) => series.metric === "views")!;
    expect(views.values).toEqual([200, 100, null, 300]);
    // The month with no review is a gap, not a zero.
    expect(views.values[2]).toBeNull();
  });

  it("YouTube views are reported in fewer than two months: not plotted, disclosed as omitted (a single dot is not a trend)", () => {
    const youtube = buildPlatformTrend(rows, "youtube");
    expect(youtube.series).toEqual([]);
    expect(youtube.omittedMetrics).toContain("views");
  });

  it("no series ever mixes platforms: Instagram's series contain no YouTube number", () => {
    const instagram = buildPlatformTrend(rows, "instagram");
    expect(JSON.stringify(instagram)).not.toContain("9000");
  });

  it("with no evidence at all there is no platform panel", () => {
    expect(platformsInHistory(rowsFor([{ month: "2026-03" }]))).toEqual([]);
  });
});
