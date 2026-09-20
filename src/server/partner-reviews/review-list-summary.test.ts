import { describe, expect, it } from "vitest";

import { buildEvidence, type AnalyticsRecordSource, type AssignmentSource, type BuildEvidenceInput, type ContentThreadSource } from "./evidence-builder";
import { neutralCommercialEvidence } from "./commercial-neutral";
import { derivePeriod } from "./period";
import { buildHeadDisplay, carriedFinalized, computeReviewListSummary, summaryOfVersion } from "./review-list-summary";
import { partnerReviewHeadDocSchema, partnerReviewVersionDocSchema, reviewListSummarySchema, type EvidenceSnapshot } from "./types";

// Step 13B: computeReviewListSummary - the compact list projection. It only COUNTS/copies stored snapshot facts.

const period = derivePeriod("2026-03")!;
const CUTOFF = "2026-05-01T00:00:00.000Z";

function assignment(over: Partial<Omit<AssignmentSource, "brief">> & { brief?: Partial<AssignmentSource["brief"]> } = {}): AssignmentSource {
  return {
    assignmentRef: "as-1",
    campaignRef: "camp-1",
    status: "IN_PROGRESS",
    version: 3,
    createdAt: "2026-01-10T08:00:00.000Z",
    updatedAt: "2026-02-01T08:00:00.000Z",
    ...over,
    brief: { campaignName: "Spring Launch", dueAt: "2026-03-10", requiredCount: 2, formats: ["reel"], platforms: ["instagram"], ...over.brief },
  };
}

function thread(over: Partial<ContentThreadSource> = {}): ContentThreadSource {
  return {
    contentRef: "ct-1",
    assignmentRef: "as-1",
    version: 4,
    status: "UNDER_REVIEW",
    currentRevisionNumber: 1,
    currentLinks: [{ platform: "instagram", originalUrl: "https://instagram.com/p/A", normalizedUrl: "https://instagram.com/p/a", recordedAt: "2026-03-08T10:00:00.000Z" }],
    openedAt: "2026-03-01T00:00:00.000Z",
    firstSubmittedAt: "2026-03-08T10:00:00.000Z",
    lastSubmittedAt: "2026-03-08T10:00:00.000Z",
    approvedAt: null,
    cancelledAt: null,
    updatedAt: "2026-03-08T10:00:00.000Z",
    ...over,
  };
}

function record(over: Partial<AnalyticsRecordSource> = {}): AnalyticsRecordSource {
  return {
    sourceRef: "src-1",
    batchRef: "batch-1",
    sheetName: "Posts",
    sourceRowNumber: 2,
    platform: "instagram",
    normalizedUrl: "https://instagram.com/p/a",
    postDateTimeIso: "2026-03-09T10:00:00.000Z",
    comments: null,
    likes: 120,
    views: null,
    profileFollowers: null,
    engagement: null,
    reportingPeriod: { start: "2026-03-01", end: "2026-03-31" },
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: "https://instagram.com/p/a", reasonCode: null, candidateCount: 1 },
    matchedContentRef: "ct-1",
    matchedAssignmentRef: "as-1",
    matchedCampaignRef: "camp-1",
    matchedPartnerRef: "partner-1",
    matchedPartnerAccountRef: null,
    correctionRevision: 1,
    createdAt: "2026-04-02T00:00:00.000Z",
    ...over,
  };
}

function built(over: Partial<BuildEvidenceInput> = {}): EvidenceSnapshot {
  return buildEvidence({
    partnerRef: "partner-1",
    period,
    evidenceCutoff: CUTOFF,
    assignments: [assignment()],
    assignmentScanTruncated: false,
    assignmentsScanned: 1,
    threads: [thread()],
    analyticsRecords: [record()],
    analyticsScanTruncated: false,
    analyticsRecordsScanned: 1,
    ...over,
  }).snapshot;
}

describe("computeReviewListSummary", () => {
  it("counts production facts from the stored snapshot", () => {
    const snapshot = built({
      assignments: [assignment(), assignment({ assignmentRef: "as-2", status: "COMPLETED" }), assignment({ assignmentRef: "as-3", status: "CANCELLED" }), assignment({ assignmentRef: "as-4" })],
      threads: [thread(), thread({ contentRef: "ct-2", assignmentRef: "as-2", status: "APPROVED", approvedAt: "2026-03-09T00:00:00.000Z" }), thread({ contentRef: "ct-4", assignmentRef: "as-4", status: "APPROVED", approvedAt: "2026-03-09T00:00:00.000Z" })],
    });
    const summary = computeReviewListSummary(snapshot);
    expect(summary.production).toEqual({ assignmentsIncluded: 4, completedAssignments: 1, underReviewContent: 1, approvedContent: 2, cancelledFlagged: 1 });
  });

  it("classifies submission timing from the stored booleans: on time, late, unknown (never counted as late)", () => {
    const snapshot = built({
      assignments: [
        assignment({ assignmentRef: "on", brief: { dueAt: "2026-03-10" } }),
        assignment({ assignmentRef: "late", brief: { dueAt: "2026-03-05" } }),
        assignment({ assignmentRef: "nodue", brief: { dueAt: null }, createdAt: "2026-03-02T00:00:00.000Z" }),
        assignment({ assignmentRef: "unsubmitted", brief: { dueAt: "2026-03-12" } }),
      ],
      threads: [thread({ contentRef: "c-on", assignmentRef: "on" }), thread({ contentRef: "c-late", assignmentRef: "late" }), thread({ contentRef: "c-nodue", assignmentRef: "nodue" }), thread({ contentRef: "c-un", assignmentRef: "unsubmitted", firstSubmittedAt: null, lastSubmittedAt: null, currentRevisionNumber: 0, currentLinks: [], status: "OPEN" })],
    });
    const { compliance } = computeReviewListSummary(snapshot);
    expect(compliance.onTime).toBe(1);
    expect(compliance.late).toBe(1);
    expect(compliance.unknownTiming).toBe(1);
    // The unsubmitted thread is open with no links: process evidence, not a timing verdict.
    expect(compliance.missingOrIncompleteWork).toBeGreaterThanOrEqual(1);
  });

  it("sums revision requests and counts missing/incomplete work", () => {
    const snapshot = built({
      assignments: [assignment({ assignmentRef: "a", status: "COMPLETED" }), assignment({ assignmentRef: "b", status: "ASSIGNED" })],
      threads: [thread({ contentRef: "ca", assignmentRef: "a", currentRevisionNumber: 3, status: "REVISION_REQUESTED" })],
    });
    const { compliance } = computeReviewListSummary(snapshot);
    expect(compliance.revisionRequests).toBe(3);
    // "b" has no thread at all (issued, non-cancelled).
    expect(compliance.missingOrIncompleteWork).toBe(1);
  });

  it("performance: missing when no in-period record exists; native per-platform sums; a metric no record reported stays null (never zero)", () => {
    const empty = computeReviewListSummary(built({ analyticsRecords: [] }));
    expect(empty.performance).toMatchObject({ state: "missing", recordCount: 0, perPlatform: {}, followerSnapshotRecords: 0, followerSnapshotAccounts: 0 });

    const summary = computeReviewListSummary(
      built({
        analyticsRecords: [
          record({ sourceRef: "i1", platform: "instagram", likes: 100, views: 1000 }),
          record({ sourceRef: "i2", platform: "instagram", likes: 20, views: null }),
          record({ sourceRef: "y1", platform: "youtube", likes: null, views: 5000, engagement: 40 }),
        ],
      }),
    );
    expect(summary.performance.state).toBe("available");
    expect(summary.performance.recordCount).toBe(3);
    expect(summary.performance.perPlatform.instagram).toEqual({ views: 1000, engagement: null, likes: 120, comments: null });
    expect(summary.performance.perPlatform.youtube).toEqual({ views: 5000, engagement: 40, likes: null, comments: null });
    // Platforms are never combined into one figure.
    expect(Object.keys(summary.performance.perPlatform).sort()).toEqual(["instagram", "youtube"]);
  });

  it("follower snapshots are COUNTED per record and per account, never summed", () => {
    const summary = computeReviewListSummary(
      built({
        analyticsRecords: [
          record({ sourceRef: "f1", profileFollowers: 1000, matchedPartnerAccountRef: "acct-1" }),
          record({ sourceRef: "f2", profileFollowers: 1200, matchedPartnerAccountRef: "acct-1" }),
          record({ sourceRef: "f3", profileFollowers: 500, matchedPartnerAccountRef: "acct-2" }),
          record({ sourceRef: "f4", profileFollowers: null, matchedPartnerAccountRef: "acct-3" }),
        ],
      }),
    );
    expect(summary.performance.followerSnapshotRecords).toBe(3);
    expect(summary.performance.followerSnapshotAccounts).toBe(2);
    expect(JSON.stringify(summary)).not.toContain("2700");
  });

  it("with no governing policy the commercial section is the all-unavailable shape, nothing invented, affectsPayment false", () => {
    const summary = computeReviewListSummary(built());
    expect(summary.commercial).toEqual({
      governing: null,
      deliverable: { required: null, actual: null, variance: null, evaluation: "unavailable", affectsPayment: false },
      lfcSfc: { status: "unavailable", lfc: null, sfc: null, unclassified: null, affectsPayment: false },
      targets: { total: 0, met: 0, notMet: 0, unavailable: 0, affectsPayment: false },
    });
  });

  it("an old snapshot with no `commercial` key reads as the neutral shape", () => {
    const snapshot = built();
    const { commercial, ...legacy } = snapshot;
    void commercial;
    expect(computeReviewListSummary(legacy).commercial.governing).toBeNull();
    expect(computeReviewListSummary(legacy).commercial.deliverable.evaluation).toBe("unavailable");
  });

  it("carries governing identity, deliverable and target results VERBATIM from the snapshot (targets are always warning-only)", () => {
    const snapshot = built();
    const commercial = neutralCommercialEvidence();
    const withPolicy: EvidenceSnapshot = {
      ...snapshot,
      commercial: {
        ...commercial,
        governingAgreement: { agreementRef: "agr-1", agreementVersion: 2 },
        monthlyDeliverable: { ...commercial.monthlyDeliverable, requiredCount: 4, actualQualifyingCount: 3, variance: -1, evaluation: "below_requirement", unavailableReason: null, affectsPayment: true },
        lfcSfc: { ...commercial.lfcSfc, status: "evaluated", unavailableReason: null, lfcCount: 2, sfcCount: 1, unclassifiedCount: 0, affectsPayment: true },
        targets: [
          { targetRef: "t1", metricId: "views", targetValue: 100, unit: "count", comparison: "at_least", actualValue: 150, evaluation: "met", unavailableReason: null, provenance: { sourceType: "analytics_source_record", refs: ["r"], recordsWithMetric: 1, recordsMissingMetric: 0 }, affectsPayment: false },
          { targetRef: "t2", metricId: "reach", targetValue: 100, unit: "count", comparison: "at_least", actualValue: null, evaluation: "unavailable", unavailableReason: "unsupported_metric", provenance: { sourceType: "analytics_source_record", refs: [], recordsWithMetric: 0, recordsMissingMetric: 0 }, affectsPayment: false },
          { targetRef: "t3", metricId: "likes", targetValue: 100, unit: "count", comparison: "at_least", actualValue: 5, evaluation: "not_met", unavailableReason: null, provenance: { sourceType: "analytics_source_record", refs: ["r"], recordsWithMetric: 1, recordsMissingMetric: 0 }, affectsPayment: false },
        ],
      },
    };
    const summary = computeReviewListSummary(withPolicy);
    expect(summary.commercial.governing).toEqual({ ref: "agr-1", version: 2 });
    expect(summary.commercial.deliverable).toEqual({ required: 4, actual: 3, variance: -1, evaluation: "below_requirement", affectsPayment: true });
    expect(summary.commercial.lfcSfc).toEqual({ status: "evaluated", lfc: 2, sfc: 1, unclassified: 0, affectsPayment: true });
    expect(summary.commercial.targets).toEqual({ total: 3, met: 1, notMet: 1, unavailable: 1, affectsPayment: false });
  });

  it("completeness: reason count and any truncation flag", () => {
    const complete = computeReviewListSummary(built());
    expect(complete.completeness).toEqual({ incompleteReasonCount: 0, truncated: false });
    const truncated = computeReviewListSummary(built({ assignmentScanTruncated: true }));
    expect(truncated.completeness.truncated).toBe(true);
    expect(truncated.completeness.incompleteReasonCount).toBeGreaterThan(0);
  });

  it("is compact (well under 3KB), schema-valid and carries no money-, score- or rank-shaped key", () => {
    const summary = computeReviewListSummary(built({ analyticsRecords: [record({ platform: "instagram" }), record({ sourceRef: "y", platform: "youtube", views: 10 })] }));
    expect(reviewListSummarySchema.safeParse(summary).success).toBe(true);
    expect(JSON.stringify(summary).length).toBeLessThan(3000);
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        walk(child);
      }
    };
    walk(summary);
    expect(keys.filter((key) => /(score|rating|overall|blended|composite|weighted|rank|amount|price|currency|fee|payable|invoice)/i.test(key))).toEqual([]);
  });
});

describe("head display block", () => {
  const snapshot = built();
  const versionBase = {
    reviewRef: "pr_00000000000000000001",
    version: 2,
    status: "DRAFT" as const,
    docVersion: 1,
    snapshot,
    evidenceCutoff: CUTOFF,
    sourceFingerprint: "a".repeat(64),
    sourceRefs: [],
    generatedAt: CUTOFF,
    generatedByUserRef: "u",
    createdAt: CUTOFF,
    createdByUserRef: "u",
  };

  it("mirrors the version, its summary, the last event, the revision count and the finalized pointer", () => {
    const version = partnerReviewVersionDocSchema.parse({ ...versionBase, summary: computeReviewListSummary(snapshot) });
    const display = buildHeadDisplay({ version, latestVersion: 3, event: { kind: "revision_created", at: "2026-05-02T00:00:00.000Z" }, finalized: { version: 2, at: "2026-04-01T00:00:00.000Z" } });
    expect(display).toMatchObject({ version: 2, status: "DRAFT", revisionCount: 2, lastEventKind: "revision_created", finalizedVersion: 2, finalizedAt: "2026-04-01T00:00:00.000Z", supersededVersion: null });
    expect(display.summary).toEqual(computeReviewListSummary(snapshot));
  });

  it("falls back to deriving the summary from the stored snapshot for a version written before Step 13B", () => {
    const legacy = partnerReviewVersionDocSchema.parse(versionBase);
    expect(legacy.summary).toBeUndefined();
    expect(summaryOfVersion(legacy)).toEqual(computeReviewListSummary(snapshot));
  });

  it("carriedFinalized keeps the recorded finalization time, else the supplied fallback; null when nothing is finalized", () => {
    const head = partnerReviewHeadDocSchema.parse({
      reviewRef: "pr_00000000000000000001",
      partnerRef: "p",
      partnerUid: "u",
      periodKey: "2026-03",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      latestVersion: 2,
      latestStatus: "DRAFT",
      currentFinalizedVersion: 1,
      openVersion: 2,
      docVersion: 3,
      createdAt: CUTOFF,
      createdByUserRef: "u",
      updatedAt: CUTOFF,
      updatedByUserRef: "u",
    });
    expect(carriedFinalized(head, "2026-04-01T00:00:00.000Z")).toEqual({ version: 1, at: "2026-04-01T00:00:00.000Z" });
    expect(carriedFinalized({ ...head, display: buildHeadDisplay({ version: partnerReviewVersionDocSchema.parse({ ...versionBase, version: 1, status: "FINALIZED" }), latestVersion: 1, event: { kind: "finalized", at: "2026-04-05T00:00:00.000Z" }, finalized: { version: 1, at: "2026-04-05T00:00:00.000Z" } }) })).toEqual({ version: 1, at: "2026-04-05T00:00:00.000Z" });
    expect(carriedFinalized({ ...head, currentFinalizedVersion: null })).toBeNull();
  });

  it("a head written before Step 13B (no display, no freshnessHint) still parses", () => {
    const head = partnerReviewHeadDocSchema.parse({
      reviewRef: "pr_00000000000000000001",
      partnerRef: "p",
      partnerUid: "u",
      periodKey: "2026-03",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      latestVersion: 1,
      latestStatus: "DRAFT",
      currentFinalizedVersion: null,
      openVersion: 1,
      docVersion: 1,
      createdAt: CUTOFF,
      createdByUserRef: "u",
      updatedAt: CUTOFF,
      updatedByUserRef: "u",
    });
    expect(head.display).toBeUndefined();
    expect(head.freshnessHint).toBeUndefined();
  });
});
