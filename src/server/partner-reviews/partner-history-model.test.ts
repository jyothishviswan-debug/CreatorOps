import { describe, expect, it } from "vitest";

import { partnerReviewHeadDocSchema, type PartnerReviewHeadDoc } from "./types";
import { buildHistoryRows, buildHistoryWindow, HISTORY_WINDOW_MONTHS, resolveHistoryMonth } from "./partner-history-model";
import { decodeCursor, encodeCursor } from "./partner-review-workspace-service";
import { resolveMonths } from "./review-view-context";
import { summaryFixture } from "../../../tests/fixtures/partner-reviews-ui";
import { reviewRefFor } from "./period";

function head(periodKey: string, over: Partial<PartnerReviewHeadDoc> = {}): PartnerReviewHeadDoc {
  return partnerReviewHeadDocSchema.parse({
    reviewRef: reviewRefFor("p1", periodKey),
    partnerRef: "p1",
    partnerUid: "u",
    periodKey,
    periodStart: `${periodKey}-01`,
    periodEnd: `${periodKey}-28`,
    latestVersion: 1,
    latestStatus: "DRAFT",
    currentFinalizedVersion: null,
    openVersion: 1,
    docVersion: 1,
    createdAt: "2026-04-01T00:00:00.000Z",
    createdByUserRef: "u",
    updatedAt: "2026-04-01T00:00:00.000Z",
    updatedByUserRef: "u",
    ...over,
  });
}

describe("Partner-wise history rows", () => {
  it("a 12-calendar-month window is bounded, newest first, with every month present", () => {
    const window = buildHistoryWindow({ end: "2026-03", olderMonths: [] });
    expect(window.months).toHaveLength(HISTORY_WINDOW_MONTHS);
    expect(window.months[0]).toBe("2026-03");
    expect(window.start).toBe("2025-04");
    expect(window.hasOlder).toBe(false);
  });

  it("older reviews / candidate months are disclosed with the window end that reaches them", () => {
    const window = buildHistoryWindow({ end: "2026-03", olderMonths: ["2026-01", "2025-02", "2024-11"] });
    expect(window.hasOlder).toBe(true);
    expect(window.olderUntil).toBe("2025-02");
  });

  it("a month with no review is 'needs_review' (candidate) or 'no_review' - never a zero and never an invented summary", () => {
    const months = ["2026-03", "2026-02", "2026-01"];
    const rows = buildHistoryRows({
      months,
      heads: new Map([["2026-03", head("2026-03")]]),
      displays: new Map([[reviewRefFor("p1", "2026-03"), { display: null, source: "unavailable" as const }]]),
      candidates: new Map([["2026-02", { partnerRef: "p1", periodKey: "2026-02", reviewRef: reviewRefFor("p1", "2026-02"), assignments: 3 }]]),
      partnerDisplayName: "Partner One",
    });
    expect(rows.map((row) => row.state)).toEqual(["review", "needs_review", "no_review"]);
    expect(rows[1]!.row).toMatchObject({ kind: "candidate", summary: null, assignmentsFound: 3 });
    expect(rows[2]!.row).toBeNull();
    // A review whose summary could not be read shows no summary (a dash), not zeros.
    expect(rows[0]!.row!.summary).toBeNull();
  });

  it("a revised month is flagged (revision count > 0) so the UI can say earlier versions are preserved", () => {
    const rows = buildHistoryRows({
      months: ["2026-03", "2026-02"],
      heads: new Map([
        ["2026-03", head("2026-03", { latestVersion: 3 })],
        ["2026-02", head("2026-02")],
      ]),
      displays: new Map(),
      candidates: new Map(),
      partnerDisplayName: "Partner One",
    });
    expect(rows[0]).toMatchObject({ revised: true });
    expect(rows[0]!.row!.revisionCount).toBe(2);
    expect(rows[1]).toMatchObject({ revised: false });
  });

  it("platform-separated summaries are carried per platform (no combined figure exists in a row)", () => {
    const summary = summaryFixture({ performance: { perPlatform: { instagram: { views: 10, engagement: null, likes: null, comments: null }, youtube: { views: 20, engagement: null, likes: null, comments: null } }, recordCount: 2 } });
    const rows = buildHistoryRows({
      months: ["2026-03"],
      heads: new Map([["2026-03", head("2026-03")]]),
      displays: new Map([[reviewRefFor("p1", "2026-03"), { display: { version: 1, status: "DRAFT" as const, summary, evidenceCutoff: "2026-04-01T00:00:00.000Z", lastEventKind: "generated" as const, lastEventAt: "2026-04-01T00:00:00.000Z", revisionCount: 0, supersededVersion: null, finalizedVersion: null, finalizedAt: null }, source: "stored" as const }]]),
      candidates: new Map(),
      partnerDisplayName: "Partner One",
    });
    const perPlatform = rows[0]!.row!.summary!.performance.perPlatform;
    expect(Object.keys(perPlatform)).toEqual(["instagram", "youtube"]);
    expect(JSON.stringify(rows[0])).not.toContain('"views":30');
  });
});

describe("Partner-wise default month", () => {
  it("an explicit month is used exactly as given", () => {
    expect(resolveHistoryMonth({ requested: "2019-01", headMonths: ["2026-03"], candidateMonths: ["2026-04"], end: "2026-04" })).toEqual({ month: "2019-01", source: "explicit" });
  });

  it("defaults to the latest EXISTING review month, else the latest candidate month, else none", () => {
    expect(resolveHistoryMonth({ requested: null, headMonths: ["2026-01", "2026-03", "2025-12"], candidateMonths: ["2026-05"], end: "2026-05" })).toEqual({ month: "2026-03", source: "latest_review" });
    expect(resolveHistoryMonth({ requested: null, headMonths: [], candidateMonths: ["2026-02", "2026-05"], end: "2026-05" })).toEqual({ month: "2026-05", source: "latest_candidate" });
    expect(resolveHistoryMonth({ requested: null, headMonths: [], candidateMonths: [], end: null })).toEqual({ month: null, source: "none" });
  });

  it("with a window end (older navigation) the default never lies beyond it", () => {
    expect(resolveHistoryMonth({ requested: null, headMonths: ["2026-03", "2025-06"], candidateMonths: [], end: "2025-12" })).toEqual({ month: "2025-06", source: "latest_review" });
  });
});

describe("Overview / Workspace month resolution", () => {
  it("default = latest month with a review head - not the (empty) current calendar month, not the latest candidate month", () => {
    const months = resolveMonths({ requested: { state: "absent" }, headMonths: ["2019-03", "2019-01"], candidateMonths: ["2019-05"] });
    expect(months.resolved).toBe("2019-03");
    expect(months.source).toBe("latest_review");
    expect(months.options.map((option) => option.month)).toEqual(["2019-05", "2019-03", "2019-01"]);
  });

  it("with no review heads the latest candidate month is used; with nothing there is no month", () => {
    expect(resolveMonths({ requested: { state: "absent" }, headMonths: [], candidateMonths: ["2019-02", "2019-04"] })).toMatchObject({ resolved: "2019-04", source: "latest_candidate" });
    expect(resolveMonths({ requested: { state: "absent" }, headMonths: [], candidateMonths: [] })).toMatchObject({ resolved: null, source: "none", options: [] });
  });

  it("an explicit valid month is never silently changed, even when it has no data, and stays selectable", () => {
    const months = resolveMonths({ requested: { state: "valid", month: "2018-07" }, headMonths: ["2019-03"], candidateMonths: [] });
    expect(months).toMatchObject({ resolved: "2018-07", source: "explicit", invalidRequested: false });
    expect(months.options.map((option) => option.month)).toContain("2018-07");
  });

  it("an invalid month falls back to the default and says so", () => {
    expect(resolveMonths({ requested: { state: "invalid" }, headMonths: ["2019-03"], candidateMonths: [] })).toMatchObject({ resolved: "2019-03", invalidRequested: true });
  });

  it("month options are bounded to the twelve most recent", () => {
    const heads = Array.from({ length: 20 }, (_, i) => `2019-${String((i % 12) + 1).padStart(2, "0")}`);
    expect(resolveMonths({ requested: { state: "absent" }, headMonths: [...new Set(heads)], candidateMonths: [] }).options.length).toBeLessThanOrEqual(13);
  });
});

describe("opaque workspace cursor", () => {
  it("round-trips an offset cursor", () => {
    expect(decodeCursor(encodeCursor({ offset: 20 }))).toEqual({ offset: 20 });
    expect(decodeCursor(encodeCursor({ offset: 0 }))).toEqual({ offset: 0 });
  });

  it("a malformed / tampered cursor is dropped, never trusted", () => {
    for (const bad of ["", "###", "e30", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ o: -1 })).toString("base64url"), Buffer.from(JSON.stringify({ o: 1.5 })).toString("base64url"), Buffer.from(JSON.stringify({ o: "3" })).toString("base64url"), Buffer.from(JSON.stringify({ o: 1_000_000 })).toString("base64url"), Buffer.from(JSON.stringify({ k: "h", c: {} })).toString("base64url"), "a".repeat(5000)]) {
      expect(decodeCursor(bad), bad.slice(0, 20)).toBeNull();
    }
    expect(decodeCursor(undefined)).toBeNull();
  });
});
