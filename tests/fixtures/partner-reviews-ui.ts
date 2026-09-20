import { reviewListSummarySchema, type ReviewListSummary } from "@/server/partner-reviews/types";
import type { ReviewListRowDto } from "@/server/partner-reviews/ui-dto";

// Test-only helpers: a schema-valid list summary and list row with overrides.
export function summaryFixture(over: { production?: Partial<ReviewListSummary["production"]>; compliance?: Partial<ReviewListSummary["compliance"]>; performance?: Partial<ReviewListSummary["performance"]>; commercial?: Partial<ReviewListSummary["commercial"]> } = {}): ReviewListSummary {
  return reviewListSummarySchema.parse({
    production: { assignmentsIncluded: 2, completedAssignments: 1, underReviewContent: 1, approvedContent: 1, cancelledFlagged: 0, ...over.production },
    commercial: {
      governing: null,
      deliverable: { required: null, actual: null, variance: null, evaluation: "unavailable", affectsPayment: false },
      lfcSfc: { status: "unavailable", lfc: null, sfc: null, unclassified: null, affectsPayment: false },
      targets: { total: 0, met: 0, notMet: 0, unavailable: 0, affectsPayment: false },
      ...over.commercial,
    },
    compliance: { onTime: 1, late: 0, unknownTiming: 0, revisionRequests: 0, missingOrIncompleteWork: 0, ...over.compliance },
    performance: { state: "available", recordCount: 1, perPlatform: { instagram: { views: 100, engagement: null, likes: 10, comments: null } }, followerSnapshotRecords: 0, followerSnapshotAccounts: 0, ...over.performance },
    completeness: { incompleteReasonCount: 0, truncated: false },
  });
}

export function rowFixture(over: Partial<ReviewListRowDto> = {}): ReviewListRowDto {
  return {
    rowKey: "p1|2026-03",
    kind: "review",
    partnerRef: "p1",
    partnerDisplayName: "Partner One",
    periodKey: "2026-03",
    reviewRef: "pr_00000000000000000001",
    version: 1,
    lifecycle: "DRAFT",
    needsReviewReason: null,
    revisionOpen: false,
    currentFinalizedVersion: null,
    finalizedAt: null,
    revisionCount: 0,
    freshnessHint: null,
    summary: summaryFixture(),
    summarySource: "stored",
    lastEvent: { kind: "generated", at: "2026-04-01T00:00:00.000Z", supersededVersion: null },
    assignmentsFound: null,
    ...over,
  };
}
