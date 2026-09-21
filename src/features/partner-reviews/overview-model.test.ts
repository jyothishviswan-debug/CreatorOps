import { describe, expect, it } from "vitest";

import type { PartnerReviewsOverviewDto } from "@/server/partner-reviews/partner-review-overview-service";
import { aggregateOverview } from "@/server/partner-reviews/overview-aggregate";
import { resolveMonths } from "@/server/partner-reviews/review-view-context";
import { rowFixture, summaryFixture } from "../../../tests/fixtures/partner-reviews-ui";

import { BOTTOM_PANEL_TITLES, buildOverviewModel, KPI_LABELS, QUICK_ACTION_LABELS, TOP_PANEL_TITLES } from "./overview-model";

// Step 13B: the approved Overview composition is STRUCTURALLY FROZEN (golden master OV_DATA["creator-reviews"]:
// 4 KPIs; top 3 panels of span 4; bottom 4 panels of span 3). These tests pin exact counts, order, spans, kinds and rows.

const hint = (state: "refresh_available" | "revision_available" | "current") => ({ state, checkedAt: "2026-04-02T00:00:00.000Z" });

function dto(rows = [rowFixture()], candidates = 0, over: Partial<PartnerReviewsOverviewDto> = {}): PartnerReviewsOverviewDto {
  return {
    month: resolveMonths({ requested: { state: "absent" }, headMonths: ["2019-03"], candidateMonths: [] }),
    counts: aggregateOverview(rows, candidates),
    activity: [{ kind: "finalized", partnerDisplayName: "Ananya", at: new Date().toISOString(), reviewRef: "pr_00000000000000000001" }],
    permissions: { canGenerate: true, canRefresh: true, canSubmit: true, canFinalize: false, canCreateRevision: true },
    disclosure: { headsRead: rows.length, headsTruncated: false, assignmentsScanned: 5, assignmentScanTruncated: false, scanLimit: 500 },
    ...over,
  };
}

describe("Overview composition", () => {
  const model = buildOverviewModel(dto());

  it("has exactly 4 KPI cards in the approved order with canonical terminology", () => {
    expect(model.kpis.map((kpi) => kpi.label)).toEqual([...KPI_LABELS]);
    expect(model.kpis.map((kpi) => kpi.label)).toEqual(["Monthly reviews", "Assignments received", "Qualifying content", "Finalized reviews"]);
  });

  it("has exactly 3 top panels in order, each span 4, with the approved kinds", () => {
    expect(model.topPanels.map((panel) => [panel.title, panel.kind, panel.span])).toEqual([
      ["Production Summary", "columns", 4],
      ["Submission Timeliness", "donut", 4],
      ["Performance Evidence", "donut", 4],
    ]);
    expect(model.topPanels.map((panel) => panel.title)).toEqual([...TOP_PANEL_TITLES]);
  });

  it("has exactly 4 bottom panels in order, each span 3, with the approved kinds", () => {
    expect(model.bottomPanels.map((panel) => [panel.title, panel.kind, panel.span])).toEqual([
      ["Review Lifecycle", "donut", 3],
      ["Needs Attention", "attention", 3],
      ["Recent Activity", "activity", 3],
      ["Quick Actions", "actions", 3],
    ]);
    expect(model.bottomPanels.map((panel) => panel.title)).toEqual([...BOTTOM_PANEL_TITLES]);
  });

  it("Production Summary rows are exactly Required / Under review / Approved / Completed assignments", () => {
    const production = model.topPanels[0]!;
    expect(production.kind === "columns" && production.rows.map((row) => row.label)).toEqual(["Required", "Under review", "Approved", "Completed assignments"]);
  });

  it("Submission Timeliness rows are On time / Late; Performance Evidence rows are Available / Stale / Missing; Review Lifecycle rows are Needs review / Draft / in review / Finalized", () => {
    const timeliness = model.topPanels[1]!;
    const performance = model.topPanels[2]!;
    const lifecycle = model.bottomPanels[0]!;
    expect(timeliness.kind === "donut" && timeliness.segments.map((segment) => segment.label)).toEqual(["On time", "Late"]);
    expect(performance.kind === "donut" && performance.segments.map((segment) => segment.label)).toEqual(["Available", "Stale", "Missing"]);
    expect(lifecycle.kind === "donut" && lifecycle.segments.map((segment) => segment.label)).toEqual(["Needs review", "Draft / in review", "Finalized"]);
  });

  it("Quick Actions are exactly the four approved destinations and each opens the real Workspace with its filter", () => {
    const actions = model.bottomPanels[3]!;
    expect(actions.kind === "actions" && actions.rows.map((row) => row.label)).toEqual([...QUICK_ACTION_LABELS]);
    expect(actions.kind === "actions" && actions.rows.map((row) => row.href)).toEqual([
      "/partner-reviews/workspace?filter=needs-review&month=2019-03",
      "/partner-reviews/workspace?filter=drafts&month=2019-03",
      "/partner-reviews/workspace?filter=finalized&month=2019-03",
      "/partner-reviews/workspace?month=2019-03",
    ]);
  });
});

describe("Required is Unavailable without an Agreement policy", () => {
  it("keeps the exact slot and renders Unavailable - never a zero, never a substituted metric", () => {
    const production = buildOverviewModel(dto()).topPanels[0]!;
    const required = production.kind === "columns" ? production.rows[0]! : null;
    expect(required).toMatchObject({ label: "Required", unavailable: true });
    // The other three rows are real counts.
    expect(production.kind === "columns" && production.rows.slice(1).every((row) => !row.unavailable)).toBe(true);
    expect(buildOverviewModel(dto()).kpis[2]!.hint).toBe("Requirement unavailable");
  });

  it("shows a numeric Required only when EVERY review in the month has an Agreement-supplied requirement", () => {
    const governed = summaryFixture({
      commercial: {
        governing: { ref: "agr", version: 1 },
        deliverable: { required: 6, actual: 4, variance: -2, evaluation: "below_requirement", affectsPayment: true },
        lfcSfc: { status: "unavailable", lfc: null, sfc: null, unclassified: null, affectsPayment: false },
        targets: { total: 0, met: 0, notMet: 0, unavailable: 0, affectsPayment: false },
      },
    });
    const all = buildOverviewModel(dto([rowFixture({ rowKey: "a", summary: governed }), rowFixture({ rowKey: "b", summary: governed })]));
    expect(all.topPanels[0]!.kind === "columns" && all.topPanels[0]!.rows[0]).toMatchObject({ label: "Required", value: 12, unavailable: false });
    expect(all.kpis[2]!.hint).toBe("of 12 required");

    const partial = buildOverviewModel(dto([rowFixture({ rowKey: "a", summary: governed }), rowFixture({ rowKey: "b" })]));
    expect(partial.topPanels[0]!.kind === "columns" && partial.topPanels[0]!.rows[0]).toMatchObject({ unavailable: true });
    expect(partial.kpis[2]!.hint).toBe("Requirement supplied for 1 of 2 reviews");
  });
});

describe("KPI mapping", () => {
  it("maps the exact figures", () => {
    const rows = [
      rowFixture({ rowKey: "a", summary: summaryFixture({ production: { assignmentsIncluded: 3, approvedContent: 2 } }) }),
      rowFixture({ rowKey: "b", lifecycle: "FINALIZED", currentFinalizedVersion: 1, summary: summaryFixture({ production: { assignmentsIncluded: 4, approvedContent: 1 } }) }),
    ];
    const { kpis } = buildOverviewModel(dto(rows));
    expect(kpis.map((kpi) => kpi.value)).toEqual(["2", "7", "3", "1"]);
    expect(kpis[0]!.hint).toBe("March 2019");
    expect(kpis[3]!.hint).toBe("of 2 monthly reviews");
  });

  it("with no review month yet every KPI is a dash with 'Not yet available' - never a zero", () => {
    const empty = buildOverviewModel(dto([], 0, { month: resolveMonths({ requested: { state: "absent" }, headMonths: [], candidateMonths: [] }) }));
    expect(empty.kpis.map((kpi) => kpi.value)).toEqual(["—", "—", "—", "—"]);
    expect(empty.kpis[0]!.hint).toBe("No review months yet");
    // The composition is unchanged: same panels, same order, same spans.
    expect(empty.topPanels.map((panel) => panel.span)).toEqual([4, 4, 4]);
    expect(empty.bottomPanels.map((panel) => panel.span)).toEqual([3, 3, 3, 3]);
  });
});

describe("Stale means 'behind at the last recorded check' - never live, never a threshold", () => {
  it("Performance Evidence: Missing, then Stale (recorded hint), then Available", () => {
    const rows = [
      rowFixture({ rowKey: "ok" }),
      rowFixture({ rowKey: "stale", freshnessHint: hint("refresh_available") }),
      rowFixture({ rowKey: "current", freshnessHint: hint("current") }),
      rowFixture({ rowKey: "miss", summary: summaryFixture({ performance: { state: "missing", recordCount: 0, perPlatform: {} } }) }),
    ];
    const performance = buildOverviewModel(dto(rows)).topPanels[2]!;
    expect(performance.kind === "donut" && performance.segments).toEqual([
      { label: "Available", value: 2 },
      { label: "Stale", value: 1 },
      { label: "Missing", value: 1 },
    ]);
    expect(performance.foot).toMatch(/last recorded check/);
    expect(JSON.stringify(performance)).toMatch(/never a composite score/);
  });
});

describe("Needs Attention shows only real non-zero actionable categories, each a real Workspace link", () => {
  it("is empty for a clean month", () => {
    const attention = buildOverviewModel(dto([rowFixture({ lifecycle: "FINALIZED", currentFinalizedVersion: 1 })])).bottomPanels[1]!;
    expect(attention.kind === "attention" && attention.rows).toEqual([]);
  });

  it("lists exactly the non-zero categories with counts and links", () => {
    const rows = [
      rowFixture({ rowKey: "a", freshnessHint: hint("refresh_available"), summary: summaryFixture({ compliance: { late: 2 } }) }),
      rowFixture({ rowKey: "b", lifecycle: "FINALIZED", currentFinalizedVersion: 1, freshnessHint: hint("revision_available"), summary: summaryFixture({ performance: { state: "missing", recordCount: 0, perPlatform: {} } }) }),
    ];
    const model = buildOverviewModel(dto(rows));
    const attention = model.bottomPanels[1]!;
    const titles = attention.kind === "attention" ? attention.rows.map((row) => row.title) : [];
    expect(titles).toEqual(["Stale evidence", "Review revision available", "Missing evidence", "Late submissions", "Draft reviews"]);
    expect(attention.kind === "attention" && attention.rows.map((row) => row.count)).toEqual(["1", "1", "1", "2", "1"]);
    expect(model.attentionLinks["Stale evidence"]).toBe("/partner-reviews/workspace?month=2019-03&signal=stale");
    expect(model.attentionLinks["Draft reviews"]).toBe("/partner-reviews/workspace?filter=drafts&month=2019-03");
    expect(Object.keys(model.attentionLinks).sort()).toEqual([...titles].sort());
  });
});

describe("Recent Activity uses Partner Review events only", () => {
  it("maps each row to its canonical event label and the review link", () => {
    const activity = buildOverviewModel(dto()).bottomPanels[2]!;
    expect(activity.kind === "activity" && activity.rows[0]).toMatchObject({ title: "Review finalized", href: "/partner-reviews/pr_00000000000000000001" });
    expect(activity.kind === "activity" && activity.rows[0]!.detail).toMatch(/^Ananya · /);
  });

  it("with no activity there are no rows (no fixture events)", () => {
    const activity = buildOverviewModel(dto([rowFixture()], 0, { activity: [] })).bottomPanels[2]!;
    expect(activity.kind === "activity" && activity.rows).toEqual([]);
  });
});

describe("no blended score / rating / rank / tier anywhere in the model", () => {
  it("has no such key or wording", () => {
    const model = buildOverviewModel(dto([rowFixture(), rowFixture({ rowKey: "b", freshnessHint: hint("refresh_available") })], 2));
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        walk(child);
      }
    };
    walk(model);
    expect(keys.filter((key) => /(score|rating|overall|blended|composite|weighted|rank|tier)/i.test(key))).toEqual([]);
    const text = JSON.stringify(model);
    expect(text).not.toMatch(/\b(rating|ranking|tier|weighted|blended score|overall score)\b/i);
    expect(text).not.toMatch(/Creator|Productivity|Deliverable/);
  });
});

describe("Overview bounded-read honesty (Step 13C)", () => {
  const truncatedDto = () => dto([rowFixture(), rowFixture()], 1, { disclosure: { headsRead: 2, headsTruncated: true, assignmentsScanned: 5, assignmentScanTruncated: false, scanLimit: 500 } });

  it("a truncated read never shows the Monthly reviews KPI as an exact month total", () => {
    const model = buildOverviewModel(truncatedDto());
    expect(model.kpis[0]).toMatchObject({ label: "Monthly reviews", value: "2+", hint: "March 2019 · first 2 read" });
    expect(model.kpis[3]!.hint).toBe("of the first 2 monthly reviews read");
    expect(model.chips).toContain("Counts cover the first 2 reviews read - the month has more");
  });

  it("a truncated read keeps the frozen composition (4 KPIs, 3 + 4 panels, same spans)", () => {
    const model = buildOverviewModel(truncatedDto());
    expect(model.kpis).toHaveLength(4);
    expect(model.topPanels.map((panel) => [panel.title, panel.span])).toEqual([["Production Summary", 4], ["Submission Timeliness", 4], ["Performance Evidence", 4]]);
    expect(model.bottomPanels.map((panel) => [panel.title, panel.span])).toEqual([["Review Lifecycle", 3], ["Needs Attention", 3], ["Recent Activity", 3], ["Quick Actions", 3]]);
  });

  it("an untruncated read is unchanged: an exact count, no bound chip", () => {
    const model = buildOverviewModel(dto([rowFixture(), rowFixture()]));
    expect(model.kpis[0]).toMatchObject({ value: "2", hint: "March 2019" });
    expect(model.kpis[3]!.hint).toBe("of 2 monthly reviews");
    expect(model.chips.some((chip) => chip.startsWith("Counts cover"))).toBe(false);
  });
});
