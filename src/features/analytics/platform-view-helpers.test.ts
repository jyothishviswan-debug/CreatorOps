import { describe, expect, it } from "vitest";

import { computeTrendGeometry, describeLatestTrendChange, formatPublishedDate, platformExplorerHref } from "./platform-view-helpers";

describe("formatPublishedDate", () => {
  it("formats a real posted date-time as a UTC date", () => {
    expect(formatPublishedDate("2026-08-12T23:30:00.000Z")).toBe("12 Aug 2026");
  });
  it("returns null (never an invented date) for missing or unparseable values", () => {
    expect(formatPublishedDate(null)).toBeNull();
    expect(formatPublishedDate("")).toBeNull();
    expect(formatPublishedDate("not a date")).toBeNull();
  });
});

describe("platformExplorerHref - only genuinely supported Explorer params", () => {
  it("carries the normalized platform and the honored recordKind, nothing else", () => {
    expect(platformExplorerHref("instagram")).toBe("/analytics/explorer?platform=instagram&recordKind=content");
    expect(platformExplorerHref("youtube", "channel")).toBe("/analytics/explorer?platform=youtube&recordKind=channel");
    const params = new URL(platformExplorerHref("youtube"), "http://x").searchParams;
    expect([...params.keys()].sort()).toEqual(["platform", "recordKind"]);
  });
});

describe("computeTrendGeometry - gaps break the line, never plot zero", () => {
  it("plots every real point and joins consecutive ones", () => {
    const { segments, points } = computeTrendGeometry([10, 20, 40]);
    expect(points).toHaveLength(3);
    expect(segments).toHaveLength(1);
    expect(points.map((p) => p.x)).toEqual([0, 130, 260]);
    expect(points[2]!.y).toBeLessThan(points[0]!.y); // larger value plots higher
  });
  it("a null period is a gap: no point, and the line splits into separate segments", () => {
    const { segments, points } = computeTrendGeometry([10, null, 30, 40]);
    expect(points.map((p) => p.value)).toEqual([10, 30, 40]);
    expect(segments.map((s) => s.map((p) => p.value))).toEqual([[10], [30, 40]]);
  });
  it("never plots a missing value at the zero baseline", () => {
    const { points } = computeTrendGeometry([null, 5, null]);
    expect(points).toHaveLength(1);
    expect(points[0]!.value).toBe(5);
  });
  it("an all-null or all-zero series stays finite (no NaN)", () => {
    expect(computeTrendGeometry([null, null]).points).toEqual([]);
    const zeros = computeTrendGeometry([0, 0]);
    expect(zeros.points.every((p) => Number.isFinite(p.y))).toBe(true);
  });
});

describe("describeLatestTrendChange", () => {
  it("compares the latest real point with its immediately preceding period", () => {
    expect(describeLatestTrendChange([100, 150])).toEqual({ latestIndex: 1, latest: 150, changePct: 50 });
  });
  it("gives no change when the neighbour is a gap or zero (never NaN/Infinity/fabricated)", () => {
    expect(describeLatestTrendChange([100, null, 150])!.changePct).toBeNull();
    expect(describeLatestTrendChange([0, 150])!.changePct).toBeNull();
  });
  it("uses the latest REAL point when the last period is a gap", () => {
    expect(describeLatestTrendChange([100, 120, null])).toEqual({ latestIndex: 1, latest: 120, changePct: 20 });
  });
  it("is null when nothing was reported", () => {
    expect(describeLatestTrendChange([null, null])).toBeNull();
  });
});
