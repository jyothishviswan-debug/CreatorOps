import { describe, expect, it } from "vitest";

import { UNSUPPORTED_METRIC_IDS } from "@/server/analytics/metric-registry";

import {
  MAX_ANALYTICS_RECORDS_IN_PERIOD,
  MAX_ASSIGNMENTS_IN_PERIOD,
  PERFORMANCE_METRIC_IDS,
  buildEvidence,
  classifyReportingPeriod,
  deriveRevisionRequestCount,
  isAssignmentInPeriod,
  resolveAssignmentEventDate,
  selectInPeriodAnalytics,
  selectInPeriodAssignments,
  snapshotHasEvidence,
  type AnalyticsRecordSource,
  type AssignmentSource,
  type BuildEvidenceInput,
  type ContentThreadSource,
} from "./evidence-builder";
import { derivePeriod } from "./period";

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
    currentLinks: [{ platform: "instagram", originalUrl: "https://instagram.com/p/A?x=1", normalizedUrl: "https://instagram.com/p/a", recordedAt: "2026-03-08T10:00:00.000Z" }],
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

function input(over: Partial<BuildEvidenceInput> = {}): BuildEvidenceInput {
  return {
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
  };
}

describe("Assignment period rule (dueAt else createdAt, UTC dates, inclusive)", () => {
  it("uses brief.dueAt when present, otherwise createdAt", () => {
    expect(resolveAssignmentEventDate(assignment({ brief: { dueAt: "2026-03-10" } }))).toEqual({ eventDate: "2026-03-10", source: "dueAt" });
    expect(resolveAssignmentEventDate(assignment({ brief: { dueAt: null }, createdAt: "2026-03-04T09:00:00.000Z" }))).toEqual({ eventDate: "2026-03-04", source: "createdAt" });
  });

  it("an unparseable dueAt is treated as absent (falls back to createdAt); an unparseable fallback cannot be placed", () => {
    expect(resolveAssignmentEventDate(assignment({ brief: { dueAt: "soon" }, createdAt: "2026-03-04T09:00:00.000Z" }))?.source).toBe("createdAt");
    expect(resolveAssignmentEventDate(assignment({ brief: { dueAt: null }, createdAt: "garbage" }))).toBeNull();
  });

  it("the first and last day of the month are in-period; the day before and after are not", () => {
    expect(isAssignmentInPeriod(assignment({ brief: { dueAt: "2026-03-01" } }), period)).toBe(true);
    expect(isAssignmentInPeriod(assignment({ brief: { dueAt: "2026-03-31" } }), period)).toBe(true);
    expect(isAssignmentInPeriod(assignment({ brief: { dueAt: "2026-02-28" } }), period)).toBe(false);
    expect(isAssignmentInPeriod(assignment({ brief: { dueAt: "2026-04-01" } }), period)).toBe(false);
    expect(isAssignmentInPeriod(assignment({ brief: { dueAt: "2026-03-31T23:59:59.999Z" } }), period)).toBe(true);
    expect(isAssignmentInPeriod(assignment({ brief: { dueAt: "2026-04-01T00:00:00.000Z" } }), period)).toBe(false);
  });

  it("a dueAt wins even when createdAt is in a different month", () => {
    expect(isAssignmentInPeriod(assignment({ brief: { dueAt: "2026-03-15" }, createdAt: "2025-01-01T00:00:00.000Z" }), period)).toBe(true);
    expect(isAssignmentInPeriod(assignment({ brief: { dueAt: "2026-05-15" }, createdAt: "2026-03-05T00:00:00.000Z" }), period)).toBe(false);
  });

  it("selection is deterministic (eventDate, assignmentRef) and capped with an explicit truncation flag", () => {
    const rows = [assignment({ assignmentRef: "b", brief: { dueAt: "2026-03-02" } }), assignment({ assignmentRef: "a", brief: { dueAt: "2026-03-02" } }), assignment({ assignmentRef: "c", brief: { dueAt: "2026-03-01" } })];
    expect(selectInPeriodAssignments(rows, period).selected.map((e) => e.assignment.assignmentRef)).toEqual(["c", "a", "b"]);
    expect(selectInPeriodAssignments([...rows].reverse(), period).selected.map((e) => e.assignment.assignmentRef)).toEqual(["c", "a", "b"]);

    const many = Array.from({ length: MAX_ASSIGNMENTS_IN_PERIOD + 1 }, (_, i) => assignment({ assignmentRef: `as-${String(i).padStart(4, "0")}`, brief: { dueAt: "2026-03-10" } }));
    const capped = selectInPeriodAssignments(many, period);
    expect(capped.selected).toHaveLength(MAX_ASSIGNMENTS_IN_PERIOD);
    expect(capped.truncated).toBe(true);
    expect(selectInPeriodAssignments(many.slice(0, MAX_ASSIGNMENTS_IN_PERIOD), period).truncated).toBe(false);
  });
});

describe("Analytics reporting-period overlap rule", () => {
  it("classifies overlap inclusively at both boundaries and rejects null / unparseable periods without dropping them silently", () => {
    expect(classifyReportingPeriod({ start: "2026-02-01", end: "2026-03-01" }, period)).toBe("in_period");
    expect(classifyReportingPeriod({ start: "2026-03-31", end: "2026-04-30" }, period)).toBe("in_period");
    expect(classifyReportingPeriod({ start: "2026-04-01", end: "2026-04-30" }, period)).toBe("outside_period");
    expect(classifyReportingPeriod({ start: "2026-02-01", end: "2026-02-28" }, period)).toBe("outside_period");
    expect(classifyReportingPeriod(null, period)).toBe("no_reporting_period");
    expect(classifyReportingPeriod({ start: "sometime", end: "2026-03-05" }, period)).toBe("unparseable_reporting_period");
    expect(classifyReportingPeriod({ start: "2026-03-20", end: "2026-03-10" }, period)).toBe("unparseable_reporting_period");
  });

  it("counts excluded records and ignores records matched to a different Partner", () => {
    const result = selectInPeriodAnalytics(
      "partner-1",
      [
        record({ sourceRef: "in" }),
        record({ sourceRef: "none", reportingPeriod: null }),
        record({ sourceRef: "bad", reportingPeriod: { start: "x", end: "y" } }),
        record({ sourceRef: "out", reportingPeriod: { start: "2026-06-01", end: "2026-06-30" } }),
        record({ sourceRef: "other", matchedPartnerRef: "partner-2" }),
      ],
      period,
    );
    expect(result.selected.map((r) => r.sourceRef)).toEqual(["in"]);
    expect(result.excludedNoReportingPeriod).toBe(1);
    expect(result.excludedUnparseableReportingPeriod).toBe(1);
  });

  it("caps in-period records with an explicit truncation flag", () => {
    const many = Array.from({ length: MAX_ANALYTICS_RECORDS_IN_PERIOD + 1 }, (_, i) => record({ sourceRef: `s-${String(i).padStart(4, "0")}` }));
    const result = selectInPeriodAnalytics("partner-1", many, period);
    expect(result.selected).toHaveLength(MAX_ANALYTICS_RECORDS_IN_PERIOD);
    expect(result.truncated).toBe(true);
  });
});

describe("buildEvidence - Performance (accepted metric registry only)", () => {
  it("a missing metric is null (never 0) and a reported zero stays 0", () => {
    const built = buildEvidence(input({ analyticsRecords: [record({ likes: 120, comments: 0, views: null })] }));
    const metrics = built.snapshot.performance.records[0]!.metrics;
    expect(metrics.likes).toBe(120);
    expect(metrics.comments).toBe(0);
    expect(metrics.views).toBeNull();
    expect(metrics.profileFollowers).toBeNull();
    expect(metrics.engagement).toBeNull();
  });

  it("carries exactly the registry's supported COUNT metrics - unsupported metrics are never synthesized", () => {
    const built = buildEvidence(input());
    expect(Object.keys(built.snapshot.performance.records[0]!.metrics).sort()).toEqual([...PERFORMANCE_METRIC_IDS].sort());
    for (const unsupported of UNSUPPORTED_METRIC_IDS) {
      expect(Object.keys(built.snapshot.performance.records[0]!.metrics)).not.toContain(unsupported);
      expect(built.snapshot.performance.metricPresence.map((p) => p.metric)).not.toContain(unsupported);
    }
    expect(built.snapshot.performance.unavailableMetrics).toEqual([...UNSUPPORTED_METRIC_IDS]);
  });

  it("reports plain per-metric presence/missing counts with no arithmetic across records", () => {
    const built = buildEvidence(
      input({
        analyticsRecords: [record({ sourceRef: "s1", likes: 10, views: 100 }), record({ sourceRef: "s2", likes: null, views: 50 }), record({ sourceRef: "s3", likes: 0, views: null })],
      }),
    );
    const presence = Object.fromEntries(built.snapshot.performance.metricPresence.map((p) => [p.metric, p]));
    expect(presence.likes).toMatchObject({ presentCount: 2, missingCount: 1 });
    expect(presence.views).toMatchObject({ presentCount: 2, missingCount: 1 });
    expect(presence.comments).toMatchObject({ presentCount: 0, missingCount: 3 });
  });

  it("preserves provenance, reporting period, source timestamps and freshness", () => {
    const built = buildEvidence(input({ analyticsRecords: [record({ createdAt: "2026-04-02T00:00:00.000Z" }), record({ sourceRef: "src-2", createdAt: "2026-04-09T00:00:00.000Z" })] }));
    const first = built.snapshot.performance.records[0]!;
    expect(first.provenance).toMatchObject({ batchRef: "batch-1", sheetName: "Posts", sourceRowNumber: 2, correctionRevision: 1, matchState: "MATCHED", matchEvidenceTier: "published_url", importedAt: "2026-04-02T00:00:00.000Z" });
    expect(first.reportingPeriod).toEqual({ start: "2026-03-01", end: "2026-03-31" });
    expect(first.postDateTime).toBe("2026-03-09T10:00:00.000Z");
    expect(built.snapshot.performance.latestImportedAt).toBe("2026-04-09T00:00:00.000Z");
  });

  it("no Analytics -> empty records, null freshness, all-zero presence counts", () => {
    const built = buildEvidence(input({ analyticsRecords: [] }));
    expect(built.snapshot.performance.records).toEqual([]);
    expect(built.snapshot.performance.latestImportedAt).toBeNull();
    expect(built.snapshot.performance.metricPresence.every((p) => p.presentCount === 0 && p.missingCount === 0)).toBe(true);
  });
});

describe("buildEvidence - Production and Compliance (raw facts, no score)", () => {
  it("captures the assignment, campaign, brief facts and the joined canonical Content thread", () => {
    const built = buildEvidence(input());
    const p = built.snapshot.production.assignments[0]!;
    expect(p).toMatchObject({ assignmentRef: "as-1", campaignRef: "camp-1", campaignName: "Spring Launch", status: "IN_PROGRESS", dueAt: "2026-03-10", eventDate: "2026-03-10", eventDateSource: "dueAt", requiredCount: 2, formats: ["reel"], platforms: ["instagram"], completed: false, cancelled: false });
    expect(p.thread).toMatchObject({ contentRef: "ct-1", status: "UNDER_REVIEW", linkCount: 1, linkPlatforms: ["instagram"], firstSubmittedAt: "2026-03-08T10:00:00.000Z" });
    expect(p.thread!.links).toEqual([{ platform: "instagram", url: "https://instagram.com/p/a" }]);
  });

  it("includes a cancelled assignment with its status, flagged, and a completed one flagged completed", () => {
    const built = buildEvidence(input({ assignments: [assignment({ assignmentRef: "x", status: "CANCELLED" }), assignment({ assignmentRef: "y", status: "COMPLETED" })], threads: [] }));
    const byRef = Object.fromEntries(built.snapshot.production.assignments.map((a) => [a.assignmentRef, a]));
    expect(byRef.x).toMatchObject({ status: "CANCELLED", cancelled: true, completed: false });
    expect(byRef.y).toMatchObject({ status: "COMPLETED", cancelled: false, completed: true });
  });

  it("compliance: submittedBeforeDue is true/false when computable and null otherwise (never guessed)", () => {
    const onTime = buildEvidence(input({ threads: [thread({ firstSubmittedAt: "2026-03-10T23:00:00.000Z" })] })).snapshot.compliance.assignments[0]!;
    expect(onTime.submittedBeforeDue).toBe(true); // date-only due = end of that UTC day
    const late = buildEvidence(input({ threads: [thread({ firstSubmittedAt: "2026-03-11T00:00:01.000Z" })] })).snapshot.compliance.assignments[0]!;
    expect(late.submittedBeforeDue).toBe(false);
    const noThread = buildEvidence(input({ threads: [] })).snapshot.compliance.assignments[0]!;
    expect(noThread.submittedBeforeDue).toBeNull();
    const noDue = buildEvidence(input({ assignments: [assignment({ brief: { dueAt: null }, createdAt: "2026-03-04T00:00:00.000Z" })] })).snapshot.compliance.assignments[0]!;
    expect(noDue.submittedBeforeDue).toBeNull();
  });

  it("compliance: explicit boolean facts against the evidence cutoff", () => {
    const pastDue = buildEvidence(input({ threads: [] })).snapshot.compliance.assignments[0]!;
    expect(pastDue).toMatchObject({ hasNoThread: true, notCompletedPastDue: true, completed: false });

    const beforeDue = buildEvidence(input({ threads: [], evidenceCutoff: "2026-03-05T00:00:00.000Z" })).snapshot.compliance.assignments[0]!;
    expect(beforeDue.notCompletedPastDue).toBe(false);

    const completed = buildEvidence(input({ assignments: [assignment({ status: "COMPLETED" })], threads: [thread({ status: "APPROVED", approvedAt: "2026-03-09T00:00:00.000Z" })] })).snapshot.compliance.assignments[0]!;
    expect(completed).toMatchObject({ completed: true, notCompletedPastDue: false, hasNoThread: false, approvedBeforeDue: true });

    const openNoLinks = buildEvidence(input({ threads: [thread({ status: "OPEN", currentLinks: [], currentRevisionNumber: 0, firstSubmittedAt: null, lastSubmittedAt: null })] })).snapshot.compliance.assignments[0]!;
    expect(openNoLinks.threadOpenWithNoLinks).toBe(true);

    const cancelled = buildEvidence(input({ assignments: [assignment({ status: "CANCELLED" })], threads: [] })).snapshot.compliance.assignments[0]!;
    expect(cancelled).toMatchObject({ hasNoThread: false, notCompletedPastDue: false, cancelled: true });
  });

  it("derives the revision-request count from canonical revision history, flagging the one inexact case", () => {
    expect(deriveRevisionRequestCount({ status: "UNDER_REVIEW", currentRevisionNumber: 1 })).toEqual({ count: 0, exact: true });
    expect(deriveRevisionRequestCount({ status: "REVISION_REQUESTED", currentRevisionNumber: 1 })).toEqual({ count: 1, exact: true });
    expect(deriveRevisionRequestCount({ status: "UNDER_REVIEW", currentRevisionNumber: 3 })).toEqual({ count: 2, exact: true });
    expect(deriveRevisionRequestCount({ status: "APPROVED", currentRevisionNumber: 3 })).toEqual({ count: 2, exact: true });
    expect(deriveRevisionRequestCount({ status: "CANCELLED", currentRevisionNumber: 2 })).toEqual({ count: 1, exact: false });
    expect(deriveRevisionRequestCount({ status: "OPEN", currentRevisionNumber: 0 })).toEqual({ count: 0, exact: true });
  });

  it("only joins threads to in-period assignments and ignores out-of-period assignments entirely", () => {
    const built = buildEvidence(
      input({ assignments: [assignment(), assignment({ assignmentRef: "as-out", brief: { dueAt: "2026-07-01" } })], threads: [thread(), thread({ contentRef: "ct-out", assignmentRef: "as-out" })] }),
    );
    expect(built.snapshot.production.assignments.map((a) => a.assignmentRef)).toEqual(["as-1"]);
    expect(built.sourceRefs.some((r) => r.ref === "ct-out" || r.ref === "as-out")).toBe(false);
  });
});

describe("buildEvidence - completeness and source refs", () => {
  it("lists typed, de-duplicated, sorted source refs across Assignment/Content/Analytics/Campaign", () => {
    const built = buildEvidence(input({ assignments: [assignment({ assignmentRef: "as-2", campaignRef: "camp-1" }), assignment()], threads: [thread(), thread({ contentRef: "ct-2", assignmentRef: "as-2" })], analyticsRecords: [record(), record({ sourceRef: "src-0" })] }));
    expect(built.sourceRefs).toEqual([
      { type: "analyticsSourceRecord", ref: "src-0" },
      { type: "analyticsSourceRecord", ref: "src-1" },
      { type: "assignment", ref: "as-1" },
      { type: "assignment", ref: "as-2" },
      { type: "campaign", ref: "camp-1" },
      { type: "content", ref: "ct-1" },
      { type: "content", ref: "ct-2" },
    ]);
    expect(built.snapshot.sourceRefs).toEqual(built.sourceRefs);
  });

  it("flags APPROVED Content with no matched in-period Analytics as a reason code (never as zero performance)", () => {
    const built = buildEvidence(input({ threads: [thread({ status: "APPROVED", approvedAt: "2026-03-09T00:00:00.000Z" })], analyticsRecords: [] }));
    expect(built.snapshot.completeness.incompleteReasons).toContain("approved_content_without_analytics");
    expect(built.snapshot.completeness.counts.approvedContentWithoutAnalytics).toBe(1);
    expect(built.snapshot.performance.records).toEqual([]);

    const covered = buildEvidence(input({ threads: [thread({ status: "APPROVED", approvedAt: "2026-03-09T00:00:00.000Z" })] }));
    expect(covered.snapshot.completeness.incompleteReasons).not.toContain("approved_content_without_analytics");
  });

  it("reports bounded-read truncation and unplaceable Analytics records as explicit reasons", () => {
    const built = buildEvidence(
      input({ assignmentScanTruncated: true, analyticsScanTruncated: true, analyticsRecords: [record(), record({ sourceRef: "n", reportingPeriod: null }), record({ sourceRef: "u", reportingPeriod: { start: "?", end: "?" } })] }),
    );
    expect(built.snapshot.completeness.incompleteReasons).toEqual(
      ["analytics_records_with_unparseable_reporting_period", "analytics_records_without_reporting_period", "analytics_scan_truncated", "assignment_scan_truncated"].sort(),
    );
    expect(built.snapshot.completeness.counts).toMatchObject({ analyticsRecordsInPeriod: 1, analyticsRecordsExcludedNoReportingPeriod: 1, analyticsRecordsExcludedUnparseableReportingPeriod: 1 });
    expect(built.snapshot.completeness.truncated).toMatchObject({ assignmentScan: true, analyticsScan: true });
  });

  it("snapshotHasEvidence is false for an empty period and true with any in-period assignment or record", () => {
    expect(snapshotHasEvidence(buildEvidence(input({ assignments: [], threads: [], analyticsRecords: [] })).snapshot)).toBe(false);
    expect(snapshotHasEvidence(buildEvidence(input({ assignments: [], threads: [] })).snapshot)).toBe(true);
    expect(snapshotHasEvidence(buildEvidence(input({ analyticsRecords: [] })).snapshot)).toBe(true);
  });
});

describe("source fingerprint", () => {
  const base = () => buildEvidence(input()).sourceFingerprint;

  it("is stable for the same facts, independent of evidence cutoff, input ordering and scan totals", () => {
    expect(buildEvidence(input({ evidenceCutoff: "2027-01-01T00:00:00.000Z" })).sourceFingerprint).toBe(base());
    expect(buildEvidence(input({ assignmentsScanned: 999, analyticsRecordsScanned: 999 })).sourceFingerprint).toBe(base());
    const a = [assignment({ assignmentRef: "a" }), assignment({ assignmentRef: "b" })];
    const t = [thread({ contentRef: "ca", assignmentRef: "a" }), thread({ contentRef: "cb", assignmentRef: "b" })];
    expect(buildEvidence(input({ assignments: a, threads: t })).sourceFingerprint).toBe(buildEvidence(input({ assignments: [...a].reverse(), threads: [...t].reverse() })).sourceFingerprint);
  });

  it("is independent of a time-dependent compliance boolean (overdue relative to the cutoff) - the snapshot changes, the fingerprint does not", () => {
    const early = buildEvidence(input({ threads: [], evidenceCutoff: "2026-03-05T00:00:00.000Z" }));
    const late = buildEvidence(input({ threads: [], evidenceCutoff: "2026-06-05T00:00:00.000Z" }));
    expect(early.snapshot.compliance.assignments[0]!.notCompletedPastDue).not.toBe(late.snapshot.compliance.assignments[0]!.notCompletedPastDue);
    expect(early.sourceFingerprint).toBe(late.sourceFingerprint);
  });

  it("changes when an Assignment, Content thread, or Analytics source changes", () => {
    const fp = base();
    expect(buildEvidence(input({ assignments: [assignment({ version: 4 })] })).sourceFingerprint).not.toBe(fp);
    expect(buildEvidence(input({ assignments: [assignment({ status: "COMPLETED" })] })).sourceFingerprint).not.toBe(fp);
    expect(buildEvidence(input({ threads: [thread({ version: 5, status: "APPROVED" })] })).sourceFingerprint).not.toBe(fp);
    expect(buildEvidence(input({ analyticsRecords: [record({ likes: 121 })] })).sourceFingerprint).not.toBe(fp);
    expect(buildEvidence(input({ analyticsRecords: [record({ correctionRevision: 2 })] })).sourceFingerprint).not.toBe(fp);
    expect(buildEvidence(input({ analyticsRecords: [record({ likes: null })] })).sourceFingerprint).not.toBe(fp);
  });

  it("changes when in-period membership changes (a record added, removed, or re-matched away)", () => {
    const fp = base();
    expect(buildEvidence(input({ analyticsRecords: [record(), record({ sourceRef: "src-2" })] })).sourceFingerprint).not.toBe(fp);
    expect(buildEvidence(input({ analyticsRecords: [] })).sourceFingerprint).not.toBe(fp);
    expect(buildEvidence(input({ analyticsRecords: [record({ matchedPartnerRef: "partner-2" })] })).sourceFingerprint).not.toBe(fp);
    expect(buildEvidence(input({ assignments: [assignment(), assignment({ assignmentRef: "as-9", brief: { dueAt: "2026-03-20" } })] })).sourceFingerprint).not.toBe(fp);
  });

  it("changes with the Partner and the period, and with a newly excluded (no-period) record", () => {
    const fp = base();
    expect(buildEvidence(input({ partnerRef: "partner-2", analyticsRecords: [record({ matchedPartnerRef: "partner-2" })] })).sourceFingerprint).not.toBe(fp);
    expect(buildEvidence(input({ analyticsRecords: [record(), record({ sourceRef: "n", reportingPeriod: null })] })).sourceFingerprint).not.toBe(fp);
  });
});

// ---- Step 13A.1: the accepted monthly inclusion policy, locked explicitly ---------------------------
// (2026-03: periodStart 2026-03-01, periodEnd 2026-03-31, UTC calendar dates, inclusive.)

describe("accepted monthly inclusion policy - Assignments (by dueAt, else createdAt)", () => {
  const inPeriodRefs = (rows: AssignmentSource[]) => buildEvidence(input({ assignments: rows, threads: [], analyticsRecords: [] })).snapshot.production.assignments.map((a) => a.assignmentRef);

  it("an Assignment belongs to the month of its dueAt, even when createdAt is in a different month", () => {
    const rows = [
      assignment({ assignmentRef: "due-in-created-out", brief: { dueAt: "2026-03-15" }, createdAt: "2025-11-01T00:00:00.000Z" }),
      assignment({ assignmentRef: "due-out-created-in", brief: { dueAt: "2026-05-15" }, createdAt: "2026-03-05T00:00:00.000Z" }),
    ];
    expect(inPeriodRefs(rows)).toEqual(["due-in-created-out"]);
    const built = buildEvidence(input({ assignments: rows, threads: [], analyticsRecords: [] }));
    expect(built.snapshot.production.assignments[0]).toMatchObject({ eventDate: "2026-03-15", eventDateSource: "dueAt" });
  });

  it("a date-only dueAt counts as that UTC date (first day and last day inclusive, day before and day after excluded)", () => {
    const rows = ["2026-02-28", "2026-03-01", "2026-03-31", "2026-04-01"].map((dueAt) => assignment({ assignmentRef: `due-${dueAt}`, brief: { dueAt } }));
    expect(inPeriodRefs(rows)).toEqual(["due-2026-03-01", "due-2026-03-31"]);
  });

  it("a date-time dueAt is converted to its UTC date before the boundary test", () => {
    // 2026-03-31T23:30:00-05:00 is 2026-04-01T04:30Z -> April; 2026-04-01T00:30:00+05:30 is 2026-03-31T19:00Z -> March.
    const rows = [assignment({ assignmentRef: "late-march-local-is-april-utc", brief: { dueAt: "2026-03-31T23:30:00-05:00" } }), assignment({ assignmentRef: "early-april-local-is-march-utc", brief: { dueAt: "2026-04-01T00:30:00+05:30" } })];
    expect(inPeriodRefs(rows)).toEqual(["early-april-local-is-march-utc"]);
  });

  it("with no dueAt the Assignment belongs to the month of its createdAt (first/last day inclusive, day before/after excluded)", () => {
    const rows = ["2026-02-28T23:59:59.999Z", "2026-03-01T00:00:00.000Z", "2026-03-31T23:59:59.999Z", "2026-04-01T00:00:00.000Z"].map((createdAt) => assignment({ assignmentRef: `created-${createdAt}`, brief: { dueAt: null }, createdAt }));
    expect(inPeriodRefs(rows)).toEqual(["created-2026-03-01T00:00:00.000Z", "created-2026-03-31T23:59:59.999Z"]);
    const built = buildEvidence(input({ assignments: [rows[1]!], threads: [], analyticsRecords: [] }));
    expect(built.snapshot.production.assignments[0]).toMatchObject({ dueAt: null, eventDate: "2026-03-01", eventDateSource: "createdAt" });
  });

  it("an unparseable dueAt is treated as missing and falls back to createdAt", () => {
    const rows = [assignment({ assignmentRef: "bad-due-created-in", brief: { dueAt: "next week" }, createdAt: "2026-03-20T00:00:00.000Z" }), assignment({ assignmentRef: "bad-due-created-out", brief: { dueAt: "next week" }, createdAt: "2026-06-20T00:00:00.000Z" })];
    expect(inPeriodRefs(rows)).toEqual(["bad-due-created-in"]);
  });

  it("an Assignment outside the month contributes nothing: no row, no source ref, no fingerprint change", () => {
    const baseline = buildEvidence(input({ threads: [], analyticsRecords: [] }));
    const withOutside = buildEvidence(input({ assignments: [assignment(), assignment({ assignmentRef: "outside", brief: { dueAt: "2026-04-01" } })], threads: [thread({ contentRef: "ct-outside", assignmentRef: "outside" })], analyticsRecords: [] }));
    expect(withOutside.sourceFingerprint).toBe(baseline.sourceFingerprint);
    expect(withOutside.sourceRefs).toEqual(baseline.sourceRefs);
  });
});

describe("accepted monthly inclusion policy - Analytics (reporting-period OVERLAP with the month)", () => {
  const includedRefs = (periods: Array<{ ref: string; period: { start: string; end: string } | null }>) =>
    buildEvidence(input({ assignments: [], threads: [], analyticsRecords: periods.map((p) => record({ sourceRef: p.ref, reportingPeriod: p.period })) })).snapshot.performance.records.map((r) => r.sourceRecordRef);

  it("includes a period fully inside, straddling either boundary, spanning the whole month, and a single boundary day", () => {
    expect(
      includedRefs([
        { ref: "fully-inside", period: { start: "2026-03-10", end: "2026-03-20" } },
        { ref: "straddles-start", period: { start: "2026-02-15", end: "2026-03-05" } },
        { ref: "straddles-end", period: { start: "2026-03-25", end: "2026-04-10" } },
        { ref: "spans-whole-month", period: { start: "2026-01-01", end: "2026-12-31" } },
        { ref: "exactly-the-month", period: { start: "2026-03-01", end: "2026-03-31" } },
        { ref: "single-day-first", period: { start: "2026-03-01", end: "2026-03-01" } },
        { ref: "single-day-last", period: { start: "2026-03-31", end: "2026-03-31" } },
        { ref: "ends-on-first-day", period: { start: "2026-02-01", end: "2026-03-01" } },
        { ref: "starts-on-last-day", period: { start: "2026-03-31", end: "2026-04-30" } },
      ]).sort(),
    ).toEqual(["ends-on-first-day", "exactly-the-month", "fully-inside", "single-day-first", "single-day-last", "spans-whole-month", "starts-on-last-day", "straddles-end", "straddles-start"]);
  });

  it("excludes a period that only touches the month from OUTSIDE (ends the day before, starts the day after) - without a reason code", () => {
    const built = buildEvidence(
      input({
        assignments: [],
        threads: [],
        analyticsRecords: [
          record({ sourceRef: "ends-day-before", reportingPeriod: { start: "2026-02-01", end: "2026-02-28" } }),
          record({ sourceRef: "starts-day-after", reportingPeriod: { start: "2026-04-01", end: "2026-04-30" } }),
        ],
      }),
    );
    expect(built.snapshot.performance.records).toEqual([]);
    expect(built.snapshot.completeness.counts).toMatchObject({ analyticsRecordsInPeriod: 0, analyticsRecordsExcludedNoReportingPeriod: 0, analyticsRecordsExcludedUnparseableReportingPeriod: 0 });
    expect(built.snapshot.completeness.incompleteReasons).toEqual([]);
  });

  it("a record with NO reporting period is excluded from the period evidence AND recorded as an incomplete-evidence reason (code + counter)", () => {
    const built = buildEvidence(input({ assignments: [], threads: [], analyticsRecords: [record({ sourceRef: "in" }), record({ sourceRef: "no-period", reportingPeriod: null })] }));
    expect(built.snapshot.performance.records.map((r) => r.sourceRecordRef)).toEqual(["in"]);
    expect(built.snapshot.completeness.counts.analyticsRecordsExcludedNoReportingPeriod).toBe(1);
    expect(built.snapshot.completeness.incompleteReasons).toContain("analytics_records_without_reporting_period");
    expect(built.sourceRefs.some((ref) => ref.ref === "no-period")).toBe(false);
    // The excluded row is part of the fingerprint (its arrival must raise freshness), yet never part of the evidence.
    const withoutIt = buildEvidence(input({ assignments: [], threads: [], analyticsRecords: [record({ sourceRef: "in" })] }));
    expect(built.sourceFingerprint).not.toBe(withoutIt.sourceFingerprint);
  });

  it("an unparseable or inverted reporting period is excluded and recorded with its own reason code and counter", () => {
    const built = buildEvidence(
      input({
        assignments: [],
        threads: [],
        analyticsRecords: [
          record({ sourceRef: "garbage", reportingPeriod: { start: "n/a", end: "n/a" } }),
          record({ sourceRef: "inverted", reportingPeriod: { start: "2026-03-20", end: "2026-03-10" } }),
          record({ sourceRef: "impossible-date", reportingPeriod: { start: "2026-02-30", end: "2026-03-05" } }),
        ],
      }),
    );
    expect(built.snapshot.performance.records).toEqual([]);
    expect(built.snapshot.completeness.counts.analyticsRecordsExcludedUnparseableReportingPeriod).toBe(3);
    expect(built.snapshot.completeness.incompleteReasons).toEqual(["analytics_records_with_unparseable_reporting_period"]);
  });
});
