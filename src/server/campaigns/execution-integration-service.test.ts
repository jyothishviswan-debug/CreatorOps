import { describe, expect, it } from "vitest";

import type { CampaignAnalyticsReadiness } from "@/server/analytics/campaign-readiness";

import {
  buildExecutionExceptionCategories,
  classifyObligationDeliveryState,
  computeCampaignExecutionOverview,
  computeCampaignExecutionSummary,
  isObligationOverdue,
  type CampaignExecutionObligation,
} from "./execution-integration-service";

// Step 12C: pure functions over already-composed, already-scope-
// constrained plain data - no Firestore, no scope logic of their own -
// exactly what makes them safe unit-test targets (same rationale as
// Analytics' own read-models.test.ts). Dates are deliberately far in the
// past/future relative to "now" rather than an injected clock, so these
// stay deterministic without needing to mock Date.

const FAR_PAST = "2000-01-01T00:00:00.000Z";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

function obligation(overrides: Partial<CampaignExecutionObligation>): CampaignExecutionObligation {
  return {
    assignmentRef: "assignment-1",
    partnerRef: "partner-1",
    dueAt: null,
    assignmentStatus: "ASSIGNED",
    contentStatus: null,
    contentCurrentLinksCount: 0,
    ...overrides,
  };
}

const NO_ANALYTICS: CampaignAnalyticsReadiness = { hasLinkedSourceRecords: false, matchedCount: 0, unmatchedCount: 0, lastDataAt: null };
const HAS_ANALYTICS: CampaignAnalyticsReadiness = { hasLinkedSourceRecords: true, matchedCount: 3, unmatchedCount: 1, lastDataAt: "2026-01-01T00:00:00.000Z" };

describe("isObligationOverdue", () => {
  it("is never overdue with no dueAt", () => {
    expect(isObligationOverdue(obligation({ dueAt: null }), FAR_FUTURE)).toBe(false);
  });

  it("is never overdue when dueAt is in the future", () => {
    expect(isObligationOverdue(obligation({ dueAt: FAR_FUTURE, assignmentStatus: "ASSIGNED" }), "2026-01-01T00:00:00.000Z")).toBe(false);
  });

  it("is overdue when dueAt has passed and the assignment/content are still open", () => {
    expect(isObligationOverdue(obligation({ dueAt: FAR_PAST, assignmentStatus: "IN_PROGRESS", contentStatus: "UNDER_REVIEW" }), "2026-01-01T00:00:00.000Z")).toBe(true);
    expect(isObligationOverdue(obligation({ dueAt: FAR_PAST, assignmentStatus: "ASSIGNED", contentStatus: null }), "2026-01-01T00:00:00.000Z")).toBe(true);
  });

  it("is never overdue once the assignment is COMPLETED, even with a past dueAt", () => {
    expect(isObligationOverdue(obligation({ dueAt: FAR_PAST, assignmentStatus: "COMPLETED" }), "2026-01-01T00:00:00.000Z")).toBe(false);
  });

  it("is never overdue once the assignment is CANCELLED, even with a past dueAt", () => {
    expect(isObligationOverdue(obligation({ dueAt: FAR_PAST, assignmentStatus: "CANCELLED" }), "2026-01-01T00:00:00.000Z")).toBe(false);
  });

  it("is never overdue once Content is APPROVED, even with a past dueAt", () => {
    expect(isObligationOverdue(obligation({ dueAt: FAR_PAST, assignmentStatus: "IN_PROGRESS", contentStatus: "APPROVED" }), "2026-01-01T00:00:00.000Z")).toBe(false);
  });
});

describe("classifyObligationDeliveryState", () => {
  it("completed: assignmentStatus COMPLETED", () => {
    expect(classifyObligationDeliveryState(obligation({ assignmentStatus: "COMPLETED", contentStatus: null }))).toBe("completed");
  });

  it("completed: contentStatus APPROVED, even if the assignment itself is still IN_PROGRESS", () => {
    expect(classifyObligationDeliveryState(obligation({ assignmentStatus: "IN_PROGRESS", contentStatus: "APPROVED" }))).toBe("completed");
  });

  it("inProgress: assignmentStatus IN_PROGRESS with no Content thread yet", () => {
    expect(classifyObligationDeliveryState(obligation({ assignmentStatus: "IN_PROGRESS", contentStatus: null }))).toBe("inProgress");
  });

  it("inProgress: contentStatus UNDER_REVIEW even while assignment is only ACCEPTED", () => {
    expect(classifyObligationDeliveryState(obligation({ assignmentStatus: "ACCEPTED", contentStatus: "UNDER_REVIEW" }))).toBe("inProgress");
  });

  it("inProgress: contentStatus REVISION_REQUESTED even while assignment is only ASSIGNED", () => {
    expect(classifyObligationDeliveryState(obligation({ assignmentStatus: "ASSIGNED", contentStatus: "REVISION_REQUESTED" }))).toBe("inProgress");
  });

  it("notStarted: assignmentStatus ASSIGNED, no Content thread", () => {
    expect(classifyObligationDeliveryState(obligation({ assignmentStatus: "ASSIGNED", contentStatus: null }))).toBe("notStarted");
  });

  it("notStarted: assignmentStatus ACCEPTED, no Content thread", () => {
    expect(classifyObligationDeliveryState(obligation({ assignmentStatus: "ACCEPTED", contentStatus: null }))).toBe("notStarted");
  });

  it("explicit rule: contentStatus OPEN alone never implies inProgress unless assignmentStatus independently reached IN_PROGRESS", () => {
    expect(classifyObligationDeliveryState(obligation({ assignmentStatus: "ASSIGNED", contentStatus: "OPEN" }))).toBe("notStarted");
    expect(classifyObligationDeliveryState(obligation({ assignmentStatus: "ACCEPTED", contentStatus: "OPEN" }))).toBe("notStarted");
  });
});

describe("computeCampaignExecutionSummary", () => {
  it("aggregates every field over a mixed set of obligations", () => {
    const obligations: CampaignExecutionObligation[] = [
      obligation({ assignmentRef: "a1", partnerRef: "p1", assignmentStatus: "COMPLETED", contentStatus: "APPROVED", contentCurrentLinksCount: 1 }),
      obligation({ assignmentRef: "a2", partnerRef: "p1", assignmentStatus: "IN_PROGRESS", contentStatus: "UNDER_REVIEW", contentCurrentLinksCount: 1 }),
      obligation({ assignmentRef: "a3", partnerRef: "p2", assignmentStatus: "ACCEPTED", contentStatus: "REVISION_REQUESTED", contentCurrentLinksCount: 1, dueAt: FAR_PAST }),
      obligation({ assignmentRef: "a4", partnerRef: "p3", assignmentStatus: "ASSIGNED", contentStatus: null, contentCurrentLinksCount: 0, dueAt: FAR_PAST }),
    ];

    const summary = computeCampaignExecutionSummary("campaign-1", obligations, HAS_ANALYTICS);

    expect(summary.campaignRef).toBe("campaign-1");
    expect(summary.totalObligations).toBe(4);
    expect(summary.approvedCount).toBe(1);
    expect(summary.distinctPartnerCount).toBe(3);
    expect(summary.overdueCount).toBe(2); // a3 (REVISION_REQUESTED) and a4 (ASSIGNED), both past-due and not APPROVED/COMPLETED/CANCELLED
    expect(summary.deliveryState).toEqual({ completed: 1, inProgress: 2, notStarted: 1 });
    expect(summary.deliveryState.completed + summary.deliveryState.inProgress + summary.deliveryState.notStarted).toBe(summary.totalObligations);
    expect(summary.underReviewCount).toBe(1);
    expect(summary.revisionRequestedCount).toBe(1);
    expect(summary.analyticsReadiness).toBe(HAS_ANALYTICS);
    expect(summary.sourceLinksComplete).toBe(false); // a4 has zero currentLinks
  });

  it("sourceLinksComplete is true only when there is at least one obligation AND every one has a link", () => {
    expect(computeCampaignExecutionSummary("c", [], NO_ANALYTICS).sourceLinksComplete).toBe(false);
    expect(computeCampaignExecutionSummary("c", [obligation({ contentCurrentLinksCount: 1 })], NO_ANALYTICS).sourceLinksComplete).toBe(true);
    expect(computeCampaignExecutionSummary("c", [obligation({ contentCurrentLinksCount: 1 }), obligation({ contentCurrentLinksCount: 0 })], NO_ANALYTICS).sourceLinksComplete).toBe(false);
  });

  it("an empty obligation set produces an honest all-zero summary, never a fabricated value", () => {
    const summary = computeCampaignExecutionSummary("empty-campaign", [], NO_ANALYTICS);
    expect(summary.totalObligations).toBe(0);
    expect(summary.approvedCount).toBe(0);
    expect(summary.distinctPartnerCount).toBe(0);
    expect(summary.overdueCount).toBe(0);
    expect(summary.deliveryState).toEqual({ completed: 0, inProgress: 0, notStarted: 0 });
    expect(summary.sourceLinksComplete).toBe(false);
  });
});

describe("computeCampaignExecutionOverview", () => {
  function campaign(campaignRef: string, name: string, updatedAt: string) {
    return { campaignRef, name, updatedAt };
  }

  it("excludes zero-obligation Campaigns from perCampaignExecution rows but counts them as unstaffed", () => {
    const overview = computeCampaignExecutionOverview([
      { campaign: campaign("c1", "Staffed Campaign", "2026-01-01T00:00:00.000Z"), obligations: [obligation({ partnerRef: "p1" })], analyticsReadiness: NO_ANALYTICS },
      { campaign: campaign("c2", "Empty Campaign", "2026-01-02T00:00:00.000Z"), obligations: [], analyticsReadiness: NO_ANALYTICS },
    ]);

    expect(overview.activeCampaignCount).toBe(2);
    expect(overview.perCampaignExecution).toEqual([{ campaignRef: "c1", campaignName: "Staffed Campaign", approvedCount: 0, totalCount: 1 }]);
    expect(overview.trackingReadiness.campaignsUnstaffedRow.badge).toBe("Review");
    expect(overview.executionExceptions.campaignsWithoutAssignments).toBe(1);
  });

  it("sorts perCampaignExecution by updatedAt descending, ties broken by campaignRef ascending, capped at 4 rows", () => {
    const perCampaign = [
      { campaign: campaign("c-b", "B", "2026-01-01T00:00:00.000Z"), obligations: [obligation({})], analyticsReadiness: NO_ANALYTICS },
      { campaign: campaign("c-a", "A", "2026-01-01T00:00:00.000Z"), obligations: [obligation({})], analyticsReadiness: NO_ANALYTICS }, // same updatedAt as c-b - tiebreak by ref
      { campaign: campaign("c-c", "C", "2026-03-01T00:00:00.000Z"), obligations: [obligation({})], analyticsReadiness: NO_ANALYTICS }, // most recent
      { campaign: campaign("c-d", "D", "2026-02-01T00:00:00.000Z"), obligations: [obligation({})], analyticsReadiness: NO_ANALYTICS },
      { campaign: campaign("c-e", "E", "2025-01-01T00:00:00.000Z"), obligations: [obligation({})], analyticsReadiness: NO_ANALYTICS }, // dropped by the 4-row cap
    ];
    const overview = computeCampaignExecutionOverview(perCampaign);
    expect(overview.perCampaignExecution.map((r) => r.campaignRef)).toEqual(["c-c", "c-d", "c-a", "c-b"]);
  });

  it("aggregates deliveryState and distinctAssignedPartnerCount portfolio-wide across all Campaigns", () => {
    const overview = computeCampaignExecutionOverview([
      {
        campaign: campaign("c1", "One", "2026-01-01T00:00:00.000Z"),
        obligations: [obligation({ partnerRef: "p1", assignmentStatus: "COMPLETED" }), obligation({ partnerRef: "p2", assignmentStatus: "ASSIGNED" })],
        analyticsReadiness: NO_ANALYTICS,
      },
      {
        campaign: campaign("c2", "Two", "2026-01-02T00:00:00.000Z"),
        obligations: [obligation({ partnerRef: "p1", assignmentStatus: "IN_PROGRESS" })], // p1 repeats - distinct count must not double it
        analyticsReadiness: HAS_ANALYTICS,
      },
    ]);
    expect(overview.distinctAssignedPartnerCount).toBe(2);
    expect(overview.totalObligations).toBe(3);
    expect(overview.deliveryState).toEqual({ completed: 1, inProgress: 1, notStarted: 1 });
    expect(overview.trackingReadiness.trackingConfiguredRow.badge).toBe("Current"); // at least one Campaign (c2) has linked Analytics data
  });

  it("trackingConfiguredRow is Not started when no in-scope active Campaign has linked Analytics data", () => {
    const overview = computeCampaignExecutionOverview([{ campaign: campaign("c1", "One", "2026-01-01T00:00:00.000Z"), obligations: [obligation({})], analyticsReadiness: NO_ANALYTICS }]);
    expect(overview.trackingReadiness.trackingConfiguredRow.badge).toBe("Not started");
  });

  it("sourceLinksCompleteRow is Partial when some obligations are missing a submitted link, Current when all have one, Review when there are none", () => {
    const partial = computeCampaignExecutionOverview([
      { campaign: campaign("c1", "One", "2026-01-01T00:00:00.000Z"), obligations: [obligation({ contentCurrentLinksCount: 1 }), obligation({ contentCurrentLinksCount: 0 })], analyticsReadiness: NO_ANALYTICS },
    ]);
    expect(partial.trackingReadiness.sourceLinksCompleteRow.badge).toBe("Partial");

    const complete = computeCampaignExecutionOverview([{ campaign: campaign("c1", "One", "2026-01-01T00:00:00.000Z"), obligations: [obligation({ contentCurrentLinksCount: 1 })], analyticsReadiness: NO_ANALYTICS }]);
    expect(complete.trackingReadiness.sourceLinksCompleteRow.badge).toBe("Current");

    const none = computeCampaignExecutionOverview([{ campaign: campaign("c1", "One", "2026-01-01T00:00:00.000Z"), obligations: [], analyticsReadiness: NO_ANALYTICS }]);
    expect(none.trackingReadiness.sourceLinksCompleteRow.badge).toBe("Review");
  });

  it("reportingEligibleRow is always honestly Unavailable - never an invented formula", () => {
    const overview = computeCampaignExecutionOverview([{ campaign: campaign("c1", "One", "2026-01-01T00:00:00.000Z"), obligations: [obligation({})], analyticsReadiness: HAS_ANALYTICS }]);
    expect(overview.trackingReadiness.reportingEligibleRow.badge).toBe("Unavailable");
  });

  it("executionExceptions counts overdue/awaiting-review/changes-requested/unstaffed independently", () => {
    const overview = computeCampaignExecutionOverview([
      {
        campaign: campaign("c1", "One", "2026-01-01T00:00:00.000Z"),
        obligations: [
          obligation({ assignmentStatus: "IN_PROGRESS", contentStatus: "UNDER_REVIEW", dueAt: FAR_PAST }),
          obligation({ assignmentStatus: "ACCEPTED", contentStatus: "REVISION_REQUESTED" }),
          obligation({ assignmentStatus: "ASSIGNED", contentStatus: null }),
        ],
        analyticsReadiness: NO_ANALYTICS,
      },
      { campaign: campaign("c2", "Two", "2026-01-01T00:00:00.000Z"), obligations: [], analyticsReadiness: NO_ANALYTICS },
    ]);
    expect(overview.executionExceptions).toEqual({ overdueContent: 1, awaitingReview: 1, changesRequested: 1, campaignsWithoutAssignments: 1 });
  });
});

describe("buildExecutionExceptionCategories", () => {
  it("includes only non-zero categories, never padded to a fixed row count", () => {
    expect(buildExecutionExceptionCategories({ overdueContent: 0, awaitingReview: 0, changesRequested: 0, campaignsWithoutAssignments: 0 })).toEqual([]);

    const rows = buildExecutionExceptionCategories({ overdueContent: 2, awaitingReview: 0, changesRequested: 1, campaignsWithoutAssignments: 0 });
    expect(rows.map((r) => r.title)).toEqual(["Overdue content", "Changes requested"]);
    expect(rows.every((r) => r.href.length > 0)).toBe(true);
  });

  it("every category links to a real, unfiltered route (neither /assignments nor /content supports a URL status filter today)", () => {
    const rows = buildExecutionExceptionCategories({ overdueContent: 1, awaitingReview: 1, changesRequested: 1, campaignsWithoutAssignments: 1 });
    expect(rows.find((r) => r.title === "Overdue content")?.href).toBe("/assignments");
    expect(rows.find((r) => r.title === "Awaiting review")?.href).toBe("/assignments");
    expect(rows.find((r) => r.title === "Changes requested")?.href).toBe("/assignments");
    expect(rows.find((r) => r.title === "Campaigns without assignments")?.href).toBe("/campaigns");
  });
});
