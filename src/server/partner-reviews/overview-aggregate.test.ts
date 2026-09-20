import { describe, expect, it } from "vitest";

import { aggregateOverview, buildRecentActivity } from "./overview-aggregate";
import { buildCandidateRow, needsReviewReasonOf, rowMatchesSignal } from "./review-rows";
import { rowFixture, summaryFixture } from "../../../tests/fixtures/partner-reviews-ui";

const hint = (state: "current" | "refresh_available" | "revision_available" | "evidence_incomplete") => ({ state, checkedAt: "2026-04-02T00:00:00.000Z" });

describe("aggregateOverview - exact semantics of every Overview figure", () => {
  it("counts reviews, finalized reviews, Assignments received and qualifying content", () => {
    const counts = aggregateOverview(
      [
        rowFixture({ rowKey: "a", summary: summaryFixture({ production: { assignmentsIncluded: 3, approvedContent: 2 } }) }),
        rowFixture({ rowKey: "b", lifecycle: "FINALIZED", currentFinalizedVersion: 1, summary: summaryFixture({ production: { assignmentsIncluded: 4, approvedContent: 1 } }) }),
      ],
      0,
    );
    expect(counts.monthlyReviews).toBe(2);
    expect(counts.finalizedReviews).toBe(1);
    expect(counts.assignmentsReceived).toBe(7);
    // No Agreement policy: qualifying content is the provable approved Content only.
    expect(counts.qualifyingContent).toBe(3);
    expect(counts.reviewsWithRequirement).toBe(0);
    expect(counts.requiredTotal).toBe(0);
  });

  it("qualifying content uses the Agreement-counted actual where a review carries one, and required only where policy supplies it", () => {
    const governed = summaryFixture({
      production: { approvedContent: 9 },
      commercial: {
        governing: { ref: "agr", version: 1 },
        deliverable: { required: 5, actual: 3, variance: -2, evaluation: "below_requirement", affectsPayment: true },
        lfcSfc: { status: "unavailable", lfc: null, sfc: null, unclassified: null, affectsPayment: false },
        targets: { total: 0, met: 0, notMet: 0, unavailable: 0, affectsPayment: false },
      },
    });
    const counts = aggregateOverview([rowFixture({ rowKey: "a", summary: governed }), rowFixture({ rowKey: "b", summary: summaryFixture({ production: { approvedContent: 2 } }) })], 0);
    expect(counts.qualifyingContent).toBe(3 + 2);
    expect(counts.requiredTotal).toBe(5);
    expect(counts.reviewsWithRequirement).toBe(1);
  });

  it("timeliness: on time / late from stored counts; unknown timing is disclosed separately and never counted as late", () => {
    const counts = aggregateOverview([rowFixture({ summary: summaryFixture({ compliance: { onTime: 5, late: 2, unknownTiming: 3 } }) })], 0);
    expect(counts.timeliness).toEqual({ onTime: 5, late: 2, unknownTiming: 3 });
    expect(counts.attention.lateSubmissions).toBe(2);
  });

  it("performance evidence is a PARTITION: Missing (no in-period record) first, then Stale (last recorded check says behind), else Available; a missing value is never zero", () => {
    const counts = aggregateOverview(
      [
        rowFixture({ rowKey: "ok" }),
        rowFixture({ rowKey: "stale", freshnessHint: hint("refresh_available") }),
        rowFixture({ rowKey: "stale2", lifecycle: "FINALIZED", currentFinalizedVersion: 1, freshnessHint: hint("revision_available") }),
        rowFixture({ rowKey: "missing", summary: summaryFixture({ performance: { state: "missing", recordCount: 0, perPlatform: {} } }) }),
        // Missing AND hinted stale: counted once, as Missing.
        rowFixture({ rowKey: "both", summary: summaryFixture({ performance: { state: "missing", recordCount: 0, perPlatform: {} } }), freshnessHint: hint("refresh_available") }),
        // Complete-but-current hint is not stale.
        rowFixture({ rowKey: "current", freshnessHint: hint("current") }),
        rowFixture({ rowKey: "inc", freshnessHint: hint("evidence_incomplete") }),
      ],
      0,
    );
    expect(counts.performance).toEqual({ available: 3, stale: 2, missing: 2 });
    expect(counts.performance.available + counts.performance.stale + counts.performance.missing).toBe(counts.monthlyReviews);
  });

  it("lifecycle is EXCLUSIVE: Needs review (candidates + behind-upstream reviews) > Draft/in review (open) > Finalized", () => {
    const counts = aggregateOverview(
      [
        rowFixture({ rowKey: "draft", lifecycle: "DRAFT" }),
        rowFixture({ rowKey: "inrev", lifecycle: "IN_REVIEW" }),
        rowFixture({ rowKey: "staleDraft", lifecycle: "DRAFT", freshnessHint: hint("refresh_available") }),
        rowFixture({ rowKey: "fin", lifecycle: "FINALIZED", currentFinalizedVersion: 1 }),
        rowFixture({ rowKey: "finStale", lifecycle: "FINALIZED", currentFinalizedVersion: 1, freshnessHint: hint("revision_available") }),
        // A finalized review with an open revision counts as Draft/in review (its open version is the current one).
        rowFixture({ rowKey: "rev", lifecycle: "DRAFT", currentFinalizedVersion: 1, revisionOpen: true }),
      ],
      3,
    );
    expect(counts.lifecycle).toEqual({ needsReview: 3 + 2, draftInReview: 3, finalized: 1 });
    expect(counts.candidates).toBe(3);
    expect(counts.lifecycle.needsReview + counts.lifecycle.draftInReview + counts.lifecycle.finalized).toBe(counts.monthlyReviews + counts.candidates);
  });

  it("attention: stale evidence (refresh available) and revision available are counted from the recorded hints only", () => {
    const counts = aggregateOverview([rowFixture({ rowKey: "a", freshnessHint: hint("refresh_available") }), rowFixture({ rowKey: "b", freshnessHint: hint("revision_available") }), rowFixture({ rowKey: "c" })], 0);
    expect(counts.attention.staleEvidence).toBe(1);
    expect(counts.attention.revisionAvailable).toBe(1);
  });

  it("commercial requirement / LFC-SFC rule 'unavailable' is only an attention item when an Agreement governs but does not supply it", () => {
    const ungoverned = aggregateOverview([rowFixture()], 0);
    expect(ungoverned.attention.requirementUnavailable).toBe(0);
    expect(ungoverned.attention.lfcSfcUnavailable).toBe(0);
    const governedNoRule = summaryFixture({
      commercial: {
        governing: { ref: "agr", version: 2 },
        deliverable: { required: null, actual: null, variance: null, evaluation: "unavailable", affectsPayment: false },
        lfcSfc: { status: "unavailable", lfc: null, sfc: null, unclassified: null, affectsPayment: false },
        targets: { total: 2, met: 0, notMet: 1, unavailable: 1, affectsPayment: false },
      },
    });
    const governed = aggregateOverview([rowFixture({ summary: governedNoRule })], 0);
    expect(governed.attention.requirementUnavailable).toBe(1);
    expect(governed.attention.lfcSfcUnavailable).toBe(1);
    // A target that could not be judged is Unavailable, never counted as Not met.
    expect(governed.attention.targetNotMet).toBe(1);
  });

  it("a review whose stored summary is unavailable is excluded from every sum and counted separately - never a zero", () => {
    const counts = aggregateOverview([rowFixture({ rowKey: "a" }), rowFixture({ rowKey: "b", summary: null, summarySource: "unavailable" })], 0);
    expect(counts.monthlyReviews).toBe(2);
    expect(counts.summaryUnavailableReviews).toBe(1);
    expect(counts.assignmentsReceived).toBe(2);
    expect(counts.performance.available + counts.performance.stale + counts.performance.missing).toBe(1);
  });

  it("an empty month has all-zero counts (the page renders neutral states, not zeros)", () => {
    const counts = aggregateOverview([], 0);
    expect(counts.monthlyReviews).toBe(0);
    expect(counts.lifecycle).toEqual({ needsReview: 0, draftInReview: 0, finalized: 0 });
  });

  it("carries no score / rating / rank / money key", () => {
    const json = JSON.stringify(aggregateOverview([rowFixture()], 1));
    expect(json).not.toMatch(/score|rating|overall|blended|composite|weighted|rank|amount|currency|payable|invoice/i);
  });
});

describe("recent activity", () => {
  it("newest first, at most six, from the last recorded event only; a finalize that superseded also yields a 'superseded' row", () => {
    const rows = Array.from({ length: 8 }, (_, i) => rowFixture({ rowKey: `r${i}`, reviewRef: `pr_0000000000000000000${i}`, partnerDisplayName: `P${i}`, lastEvent: { kind: "submitted", at: `2026-04-0${i + 1}T00:00:00.000Z`, supersededVersion: null } }));
    rows.push(rowFixture({ rowKey: "fin", reviewRef: "pr_00000000000000000099", partnerDisplayName: "Fin", lastEvent: { kind: "finalized", at: "2026-04-20T00:00:00.000Z", supersededVersion: 1 } }));
    const activity = buildRecentActivity(rows);
    expect(activity).toHaveLength(6);
    expect(activity.slice(0, 2).map((row) => row.kind)).toEqual(["finalized", "superseded"]);
    expect(activity.map((row) => row.at)).toEqual([...activity.map((row) => row.at)].sort().reverse());
  });

  it("a review with no recorded event contributes nothing (never invented)", () => {
    expect(buildRecentActivity([rowFixture({ lastEvent: null }), rowFixture({ reviewRef: null })])).toEqual([]);
  });
});

describe("row helpers", () => {
  it("needsReviewReasonOf reads only the recorded hint", () => {
    expect(needsReviewReasonOf(null)).toBeNull();
    expect(needsReviewReasonOf(hint("current"))).toBeNull();
    expect(needsReviewReasonOf(hint("evidence_incomplete"))).toBeNull();
    expect(needsReviewReasonOf(hint("refresh_available"))).toBe("refresh_available");
    expect(needsReviewReasonOf(hint("revision_available"))).toBe("revision_available");
  });

  it("a candidate row is a Needs Review row with no review, no summary and no counts", () => {
    const row = buildCandidateRow({ partnerRef: "p1", periodKey: "2026-03", reviewRef: "pr_x", assignments: 4 }, { displayName: "Partner One" });
    expect(row).toMatchObject({ kind: "candidate", lifecycle: "NEEDS_REVIEW", reviewRef: null, summary: null, needsReviewReason: "no_review", assignmentsFound: 4 });
  });

  it("signal membership uses only stored summary facts and recorded hints; a candidate never matches", () => {
    const late = rowFixture({ summary: summaryFixture({ compliance: { late: 2 } }) });
    expect(rowMatchesSignal(late, "late")).toBe(true);
    expect(rowMatchesSignal(rowFixture(), "late")).toBe(false);
    expect(rowMatchesSignal(rowFixture({ freshnessHint: hint("refresh_available") }), "stale")).toBe(true);
    expect(rowMatchesSignal(rowFixture({ freshnessHint: hint("revision_available") }), "stale")).toBe(false);
    expect(rowMatchesSignal(rowFixture({ freshnessHint: hint("revision_available") }), "revision_available")).toBe(true);
    expect(rowMatchesSignal(rowFixture({ summary: summaryFixture({ performance: { state: "missing", recordCount: 0, perPlatform: {} } }) }), "missing_evidence")).toBe(true);
    expect(rowMatchesSignal(buildCandidateRow({ partnerRef: "p", periodKey: "2026-03", reviewRef: "pr_x", assignments: 1 }, { displayName: "P" }), "late")).toBe(false);
  });
});
