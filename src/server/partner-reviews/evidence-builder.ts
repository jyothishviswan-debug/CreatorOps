import type { AnalyticsContentSourceRecordDoc } from "@/server/analytics/types";
import { ANALYTICS_METRIC_IDS, ANALYTICS_METRIC_REGISTRY, UNSUPPORTED_METRIC_IDS, type AnalyticsMetricId } from "@/server/analytics/metric-registry";
import type { AssignmentBrief, AssignmentDoc } from "@/server/assignments/types";
import type { ContentDoc } from "@/server/content/types";

import { computeSourceFingerprint } from "./fingerprint";
import { dateRangeOverlapsPeriod, dueInstantMs, parseLeadingUtcDate, toUtcDate, type ReviewPeriod } from "./period";
import {
  evidenceSnapshotSchema,
  type EvidenceComplianceAssignment,
  type EvidencePerformanceRecord,
  type EvidenceProductionAssignment,
  type EvidenceSnapshot,
  type EvidenceThread,
  type PartnerReviewSourceRef,
} from "./types";

// Step 13A: the ONE pure evidence builder. It takes already-read upstream
// documents (see evidence-collector.ts, the one I/O collector) and returns
// the deterministic snapshot, the sorted source refs and the source
// fingerprint. No I/O, no clock - the evidence cutoff is a parameter.
//
// Hard rules encoded here:
//  - Production, Compliance and Performance are three independent sections;
//    nothing is summed/blended across them and no score/rating/rank exists.
//  - Performance comes from Analytics content source records only, using the
//    accepted metric registry's supported COUNT metrics; a metric the
//    source did not report is null (never zero); unsupported metrics are
//    listed as unavailable, never synthesized.
//  - Compliance is raw structured facts derived from canonical operational
//    history (Assignment + Content thread) against the evidence cutoff.

// --- Bounds -------------------------------------------------------------------
// Per-source in-period caps keep one version document comfortably below
// Firestore's 1 MiB document limit even in the worst case. Exceeding a cap
// sets an explicit truncation flag (and an incomplete reason) - evidence is
// never silently dropped.
export const MAX_ASSIGNMENTS_IN_PERIOD = 200;
export const MAX_ANALYTICS_RECORDS_IN_PERIOD = 400;

// --- Source shapes (Pick'd so tests can supply just what matters) -------------
export type AssignmentSource = Pick<AssignmentDoc, "assignmentRef" | "campaignRef" | "status" | "version" | "createdAt" | "updatedAt"> & {
  brief: Pick<AssignmentBrief, "campaignName" | "dueAt" | "requiredCount" | "formats" | "platforms">;
};

export type ContentThreadSource = Pick<
  ContentDoc,
  "contentRef" | "assignmentRef" | "version" | "status" | "currentRevisionNumber" | "currentLinks" | "openedAt" | "firstSubmittedAt" | "lastSubmittedAt" | "approvedAt" | "cancelledAt" | "updatedAt"
>;

export type AnalyticsRecordSource = Pick<
  AnalyticsContentSourceRecordDoc,
  | "sourceRef"
  | "batchRef"
  | "sheetName"
  | "sourceRowNumber"
  | "platform"
  | "normalizedUrl"
  | "postDateTimeIso"
  | "comments"
  | "likes"
  | "views"
  | "profileFollowers"
  | "engagement"
  | "reportingPeriod"
  | "matchState"
  | "matchEvidence"
  | "matchedContentRef"
  | "matchedAssignmentRef"
  | "matchedCampaignRef"
  | "matchedPartnerRef"
  | "matchedPartnerAccountRef"
  | "correctionRevision"
  | "createdAt"
>;

// --- Metrics (accepted registry only) ------------------------------------------
// The supported COUNT metrics of the Analytics metric registry. Identity/
// text/datetime/url registry entries are context, not measured metrics.
export const PERFORMANCE_METRIC_IDS: readonly AnalyticsMetricId[] = ANALYTICS_METRIC_IDS.filter((id) => ANALYTICS_METRIC_REGISTRY[id].kind === "count");

function readMetric(record: AnalyticsRecordSource, metric: AnalyticsMetricId): number | null {
  const value = (record as unknown as Record<string, unknown>)[metric];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// --- Assignment period membership ------------------------------------------------
// RULE (one documented function): an Assignment's authoritative event date
// is brief.dueAt when it is present AND parses to a date; otherwise its
// createdAt. The Assignment is in the period iff that UTC calendar date is
// within [periodStart, periodEnd] (inclusive). An unparseable dueAt is
// treated as absent (falls back to createdAt); an Assignment whose
// fallback date is also unparseable cannot be placed and is not included.
export function resolveAssignmentEventDate(assignment: Pick<AssignmentSource, "createdAt"> & { brief: Pick<AssignmentBrief, "dueAt"> }): { eventDate: string; source: "dueAt" | "createdAt" } | null {
  if (assignment.brief.dueAt) {
    const fromDue = toUtcDate(assignment.brief.dueAt);
    if (fromDue) return { eventDate: fromDue, source: "dueAt" };
  }
  const fromCreated = toUtcDate(assignment.createdAt);
  return fromCreated ? { eventDate: fromCreated, source: "createdAt" } : null;
}

export function isAssignmentInPeriod(assignment: Pick<AssignmentSource, "createdAt"> & { brief: Pick<AssignmentBrief, "dueAt"> }, period: ReviewPeriod): boolean {
  const resolved = resolveAssignmentEventDate(assignment);
  if (!resolved) return false;
  return resolved.eventDate >= period.periodStart && resolved.eventDate <= period.periodEnd;
}

// Deterministic (eventDate, assignmentRef) order, capped; the flag reports
// whether the cap dropped anything.
export function selectInPeriodAssignments<T extends AssignmentSource>(assignments: readonly T[], period: ReviewPeriod): { selected: Array<{ assignment: T; eventDate: string; eventDateSource: "dueAt" | "createdAt" }>; truncated: boolean } {
  const inPeriod: Array<{ assignment: T; eventDate: string; eventDateSource: "dueAt" | "createdAt" }> = [];
  for (const assignment of assignments) {
    const resolved = resolveAssignmentEventDate(assignment);
    if (!resolved) continue;
    if (resolved.eventDate < period.periodStart || resolved.eventDate > period.periodEnd) continue;
    inPeriod.push({ assignment, eventDate: resolved.eventDate, eventDateSource: resolved.source });
  }
  inPeriod.sort((a, b) => (a.eventDate === b.eventDate ? (a.assignment.assignmentRef < b.assignment.assignmentRef ? -1 : 1) : a.eventDate < b.eventDate ? -1 : 1));
  return { selected: inPeriod.slice(0, MAX_ASSIGNMENTS_IN_PERIOD), truncated: inPeriod.length > MAX_ASSIGNMENTS_IN_PERIOD };
}

// --- Analytics reporting-period overlap ------------------------------------------
// RULE: a content source record matched to the Partner counts toward a
// period iff its reportingPeriod [start, end] (UTC calendar dates,
// boundaries inclusive) OVERLAPS [periodStart, periodEnd]. A record with no
// reporting period is not placed in any period (counted as
// excludedNoReportingPeriod); a record whose period bounds are not
// confidently parseable dates, or whose start is after its end, is counted
// as excludedUnparseableReportingPeriod. Nothing is dropped silently.
export type AnalyticsPeriodClassification = "in_period" | "outside_period" | "no_reporting_period" | "unparseable_reporting_period";

export function classifyReportingPeriod(reportingPeriod: { start: string; end: string } | null, period: ReviewPeriod): AnalyticsPeriodClassification {
  if (!reportingPeriod) return "no_reporting_period";
  const start = parseLeadingUtcDate(reportingPeriod.start);
  const end = parseLeadingUtcDate(reportingPeriod.end);
  if (!start || !end || start > end) return "unparseable_reporting_period";
  return dateRangeOverlapsPeriod(start, end, period) ? "in_period" : "outside_period";
}

export function selectInPeriodAnalytics<T extends AnalyticsRecordSource>(
  partnerRef: string,
  records: readonly T[],
  period: ReviewPeriod,
): { selected: T[]; excludedNoReportingPeriod: number; excludedUnparseableReportingPeriod: number; truncated: boolean } {
  const selected: T[] = [];
  let excludedNoReportingPeriod = 0;
  let excludedUnparseableReportingPeriod = 0;

  for (const record of records) {
    // Defense in depth: the collector already queries by matchedPartnerRef.
    if (record.matchedPartnerRef !== partnerRef) continue;
    const classification = classifyReportingPeriod(record.reportingPeriod, period);
    if (classification === "no_reporting_period") excludedNoReportingPeriod += 1;
    else if (classification === "unparseable_reporting_period") excludedUnparseableReportingPeriod += 1;
    else if (classification === "in_period") selected.push(record);
  }

  selected.sort((a, b) => {
    const aStart = a.reportingPeriod?.start ?? "";
    const bStart = b.reportingPeriod?.start ?? "";
    if (aStart !== bStart) return aStart < bStart ? -1 : 1;
    return a.sourceRef < b.sourceRef ? -1 : a.sourceRef > b.sourceRef ? 1 : 0;
  });

  return {
    selected: selected.slice(0, MAX_ANALYTICS_RECORDS_IN_PERIOD),
    excludedNoReportingPeriod,
    excludedUnparseableReportingPeriod,
    truncated: selected.length > MAX_ANALYTICS_RECORDS_IN_PERIOD,
  };
}

// --- Content thread evidence -----------------------------------------------------
// Revision requests are derived from the canonical revision history so no
// per-thread event read is needed: every revision beyond the first was
// submitted in answer to a request, and a thread currently in
// REVISION_REQUESTED has one further, still-open request. The count is
// exact except for a thread CANCELLED while a request was open (that one
// request is not recoverable from the thread's own fields), which is
// reported via revisionRequestCountIsExact = false rather than guessed.
export function deriveRevisionRequestCount(thread: Pick<ContentThreadSource, "status" | "currentRevisionNumber">): { count: number; exact: boolean } {
  const answered = Math.max(0, thread.currentRevisionNumber - 1);
  const open = thread.status === "REVISION_REQUESTED" ? 1 : 0;
  return { count: answered + open, exact: thread.status !== "CANCELLED" };
}

function buildThread(thread: ContentThreadSource): EvidenceThread {
  const { count, exact } = deriveRevisionRequestCount(thread);
  return {
    contentRef: thread.contentRef,
    status: thread.status,
    currentRevisionNumber: thread.currentRevisionNumber,
    openedAt: thread.openedAt,
    firstSubmittedAt: thread.firstSubmittedAt,
    lastSubmittedAt: thread.lastSubmittedAt,
    approvedAt: thread.approvedAt,
    cancelledAt: thread.cancelledAt,
    linkCount: thread.currentLinks.length,
    linkPlatforms: [...new Set(thread.currentLinks.map((link) => link.platform))].sort(),
    // Public publication links only (the normalized post URL) - bounded by
    // the Content schema's own MAX_CONTENT_LINKS.
    links: thread.currentLinks.map((link) => ({ platform: link.platform, url: link.normalizedUrl })),
    revisionRequestCount: count,
    revisionRequestCountIsExact: exact,
  };
}

const OBLIGATION_ACTIVE_STATUSES: readonly string[] = ["ASSIGNED", "ACCEPTED", "IN_PROGRESS"];
const ISSUED_NON_CANCELLED_STATUSES: readonly string[] = ["ASSIGNED", "ACCEPTED", "IN_PROGRESS", "COMPLETED"];

// --- The builder --------------------------------------------------------------------
export type BuildEvidenceInput = {
  partnerRef: string;
  period: ReviewPeriod;
  // ISO instant the evidence was collected (server time).
  evidenceCutoff: string;
  assignments: readonly AssignmentSource[];
  assignmentScanTruncated: boolean;
  assignmentsScanned: number;
  // Canonical Content threads for the in-period Assignments (any extra
  // threads are ignored).
  threads: readonly ContentThreadSource[];
  analyticsRecords: readonly AnalyticsRecordSource[];
  analyticsScanTruncated: boolean;
  analyticsRecordsScanned: number;
};

export type BuiltEvidence = {
  snapshot: EvidenceSnapshot;
  sourceRefs: PartnerReviewSourceRef[];
  sourceFingerprint: string;
};

export function buildEvidence(input: BuildEvidenceInput): BuiltEvidence {
  const cutoffMs = Date.parse(input.evidenceCutoff);

  const assignmentSelection = selectInPeriodAssignments(input.assignments, input.period);
  const inPeriodRefs = new Set(assignmentSelection.selected.map((entry) => entry.assignment.assignmentRef));
  const threadByAssignmentRef = new Map<string, ContentThreadSource>();
  for (const thread of input.threads) {
    if (inPeriodRefs.has(thread.assignmentRef)) threadByAssignmentRef.set(thread.assignmentRef, thread);
  }

  const analyticsSelection = selectInPeriodAnalytics(input.partnerRef, input.analyticsRecords, input.period);

  // --- Production + Compliance -------------------------------------------------
  const production: EvidenceProductionAssignment[] = [];
  const compliance: EvidenceComplianceAssignment[] = [];

  for (const { assignment, eventDate, eventDateSource } of assignmentSelection.selected) {
    const thread = threadByAssignmentRef.get(assignment.assignmentRef) ?? null;
    const threadEvidence = thread ? buildThread(thread) : null;
    const completed = assignment.status === "COMPLETED";
    const cancelled = assignment.status === "CANCELLED";

    production.push({
      assignmentRef: assignment.assignmentRef,
      campaignRef: assignment.campaignRef,
      campaignName: assignment.brief.campaignName,
      status: assignment.status,
      dueAt: assignment.brief.dueAt,
      eventDate,
      eventDateSource,
      requiredCount: assignment.brief.requiredCount,
      formats: [...assignment.brief.formats],
      platforms: [...assignment.brief.platforms],
      createdAt: assignment.createdAt,
      completed,
      cancelled,
      thread: threadEvidence,
    });

    const dueMs = assignment.brief.dueAt ? dueInstantMs(assignment.brief.dueAt) : null;
    const submittedMs = thread?.firstSubmittedAt ? Date.parse(thread.firstSubmittedAt) : null;
    const approvedMs = thread?.approvedAt ? Date.parse(thread.approvedAt) : null;
    const revision = thread ? deriveRevisionRequestCount(thread) : { count: 0, exact: true };

    compliance.push({
      assignmentRef: assignment.assignmentRef,
      dueAt: assignment.brief.dueAt,
      submittedAt: thread?.firstSubmittedAt ?? null,
      approvedAt: thread?.approvedAt ?? null,
      submittedBeforeDue: dueMs !== null && submittedMs !== null && !Number.isNaN(submittedMs) ? submittedMs <= dueMs : null,
      approvedBeforeDue: dueMs !== null && approvedMs !== null && !Number.isNaN(approvedMs) ? approvedMs <= dueMs : null,
      revisionRequestCount: revision.count,
      revisionRequestCountIsExact: revision.exact,
      threadStatus: thread?.status ?? null,
      hasNoThread: thread === null && ISSUED_NON_CANCELLED_STATUSES.includes(assignment.status),
      threadOpenWithNoLinks: thread !== null && thread.status === "OPEN" && thread.currentLinks.length === 0,
      notCompletedPastDue: OBLIGATION_ACTIVE_STATUSES.includes(assignment.status) && dueMs !== null && !Number.isNaN(cutoffMs) && cutoffMs > dueMs,
      completed,
      cancelled,
      assignmentStatus: assignment.status,
    });
  }

  // --- Performance ---------------------------------------------------------------
  const records: EvidencePerformanceRecord[] = analyticsSelection.selected.map((record) => {
    const metrics: Record<string, number | null> = {};
    for (const metric of PERFORMANCE_METRIC_IDS) metrics[metric] = readMetric(record, metric);
    return {
      sourceRecordRef: record.sourceRef,
      platform: record.platform,
      matchedContentRef: record.matchedContentRef,
      matchedAssignmentRef: record.matchedAssignmentRef,
      matchedCampaignRef: record.matchedCampaignRef,
      matchedPartnerAccountRef: record.matchedPartnerAccountRef,
      postUrl: record.normalizedUrl,
      postDateTime: record.postDateTimeIso,
      reportingPeriod: { start: record.reportingPeriod!.start, end: record.reportingPeriod!.end },
      provenance: {
        batchRef: record.batchRef,
        sheetName: record.sheetName,
        sourceRowNumber: record.sourceRowNumber,
        correctionRevision: record.correctionRevision,
        matchState: record.matchState,
        matchEvidenceTier: record.matchEvidence.tier,
        matchReasonCode: record.matchEvidence.reasonCode,
        importedAt: record.createdAt,
      },
      metrics,
    };
  });

  // Plain per-metric presence counts - no arithmetic across records.
  const metricPresence = PERFORMANCE_METRIC_IDS.map((metric) => {
    const present = records.filter((record) => record.metrics[metric] !== null).length;
    return { metric, presentCount: present, missingCount: records.length - present };
  });

  const latestImportedAt = records.reduce<string | null>((latest, record) => (latest === null || record.provenance.importedAt > latest ? record.provenance.importedAt : latest), null);

  // --- Completeness ----------------------------------------------------------------
  const analyticsContentRefs = new Set(records.map((record) => record.matchedContentRef).filter((ref): ref is string => ref !== null));
  const approvedContentWithoutAnalytics = production.filter((entry) => entry.thread?.status === "APPROVED" && !analyticsContentRefs.has(entry.thread.contentRef)).length;

  const incompleteReasons: string[] = [];
  if (input.assignmentScanTruncated) incompleteReasons.push("assignment_scan_truncated");
  if (assignmentSelection.truncated) incompleteReasons.push("assignments_in_period_truncated");
  if (input.analyticsScanTruncated) incompleteReasons.push("analytics_scan_truncated");
  if (analyticsSelection.truncated) incompleteReasons.push("analytics_records_in_period_truncated");
  if (approvedContentWithoutAnalytics > 0) incompleteReasons.push("approved_content_without_analytics");
  if (analyticsSelection.excludedNoReportingPeriod > 0) incompleteReasons.push("analytics_records_without_reporting_period");
  if (analyticsSelection.excludedUnparseableReportingPeriod > 0) incompleteReasons.push("analytics_records_with_unparseable_reporting_period");
  incompleteReasons.sort();

  // --- Source refs ---------------------------------------------------------------------
  const refKeys = new Map<string, PartnerReviewSourceRef>();
  const addRef = (type: PartnerReviewSourceRef["type"], ref: string) => refKeys.set(`${type} ${ref}`, { type, ref });
  for (const entry of production) {
    addRef("assignment", entry.assignmentRef);
    addRef("campaign", entry.campaignRef);
    if (entry.thread) addRef("content", entry.thread.contentRef);
  }
  for (const record of records) addRef("analyticsSourceRecord", record.sourceRecordRef);
  const sourceRefs = [...refKeys.values()].sort((a, b) => (a.type === b.type ? (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0) : a.type < b.type ? -1 : 1));

  const snapshot: EvidenceSnapshot = evidenceSnapshotSchema.parse({
    schemaVersion: 1,
    partnerRef: input.partnerRef,
    periodKey: input.period.periodKey,
    periodStart: input.period.periodStart,
    periodEnd: input.period.periodEnd,
    evidenceCutoff: input.evidenceCutoff,
    production: { assignments: production },
    compliance: { assignments: compliance },
    performance: {
      records,
      metricPresence,
      // Verbatim from the accepted registry - "not available", never estimated.
      unavailableMetrics: [...UNSUPPORTED_METRIC_IDS],
      latestImportedAt,
    },
    completeness: {
      truncated: {
        assignmentScan: input.assignmentScanTruncated,
        assignmentsInPeriod: assignmentSelection.truncated,
        analyticsScan: input.analyticsScanTruncated,
        analyticsRecordsInPeriod: analyticsSelection.truncated,
      },
      counts: {
        assignmentsScanned: input.assignmentsScanned,
        assignmentsInPeriod: production.length,
        threadsFound: production.filter((entry) => entry.thread !== null).length,
        analyticsRecordsScanned: input.analyticsRecordsScanned,
        analyticsRecordsInPeriod: records.length,
        analyticsRecordsExcludedNoReportingPeriod: analyticsSelection.excludedNoReportingPeriod,
        analyticsRecordsExcludedUnparseableReportingPeriod: analyticsSelection.excludedUnparseableReportingPeriod,
        approvedContentWithoutAnalytics,
      },
      incompleteReasons,
    },
    sourceRefs,
  });

  // --- Fingerprint: SOURCE FACTS only, nothing time-dependent -------------------------
  // (no evidence cutoff, no overdue-relative-to-now boolean, no scan totals).
  const sourceFingerprint = computeSourceFingerprint({
    schemaVersion: 1,
    partnerRef: input.partnerRef,
    periodKey: input.period.periodKey,
    assignments: assignmentSelection.selected.map(({ assignment, eventDate }) => ({
      ref: assignment.assignmentRef,
      version: assignment.version,
      status: assignment.status,
      updatedAt: assignment.updatedAt,
      dueAt: assignment.brief.dueAt,
      createdAt: assignment.createdAt,
      campaignRef: assignment.campaignRef,
      eventDate,
    })),
    threads: assignmentSelection.selected
      .map(({ assignment }) => threadByAssignmentRef.get(assignment.assignmentRef))
      .filter((thread): thread is ContentThreadSource => thread !== undefined)
      .map((thread) => ({
        ref: thread.contentRef,
        assignmentRef: thread.assignmentRef,
        version: thread.version,
        status: thread.status,
        revision: thread.currentRevisionNumber,
        updatedAt: thread.updatedAt,
        linkCount: thread.currentLinks.length,
      })),
    analytics: analyticsSelection.selected.map((record) => ({
      ref: record.sourceRef,
      correctionRevision: record.correctionRevision,
      importedAt: record.createdAt,
      matchState: record.matchState,
      matchedContentRef: record.matchedContentRef,
      reportingPeriod: record.reportingPeriod,
      metrics: Object.fromEntries(PERFORMANCE_METRIC_IDS.map((metric) => [metric, readMetric(record, metric)])),
    })),
    excluded: {
      noReportingPeriod: analyticsSelection.excludedNoReportingPeriod,
      unparseableReportingPeriod: analyticsSelection.excludedUnparseableReportingPeriod,
    },
    truncated: {
      assignmentScan: input.assignmentScanTruncated,
      assignmentsInPeriod: assignmentSelection.truncated,
      analyticsScan: input.analyticsScanTruncated,
      analyticsRecordsInPeriod: analyticsSelection.truncated,
    },
  });

  return { snapshot, sourceRefs, sourceFingerprint };
}

// True when the built snapshot carries any in-period evidence at all.
export function snapshotHasEvidence(snapshot: Pick<EvidenceSnapshot, "production" | "performance">): boolean {
  return snapshot.production.assignments.length > 0 || snapshot.performance.records.length > 0;
}
