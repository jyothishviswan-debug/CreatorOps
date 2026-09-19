import { z } from "zod";

// Step 13A: the canonical Partner Reviews domain. One logical review
// ("head") = exactly one Partner + one calendar-month review period. Each
// head owns an append-only chain of numbered VERSIONS; each version holds a
// deterministic, auditable evidence snapshot derived from canonical
// upstream truth (Assignments, Content, Analytics) - never a duplicate
// source of those records, and never a blended/composite/overall score.
// Production, Compliance and Performance stay three independent sections.
//
// Follows the same contract shape as src/server/assignments/types.ts
// deliberately, so the domains stay recognizably parallel.

// --- Version lifecycle -----------------------------------------------------
// DRAFT -> IN_REVIEW -> FINALIZED -> SUPERSEDED. NEEDS_REVIEW is derived,
// never persisted. The graph itself lives in
// @/server/authz/lifecycle's PARTNER_REVIEW_LIFECYCLE_TRANSITIONS.
export const PARTNER_REVIEW_STATUSES = ["DRAFT", "IN_REVIEW", "FINALIZED", "SUPERSEDED"] as const;
export const partnerReviewStatusSchema = z.enum(PARTNER_REVIEW_STATUSES);
export type PartnerReviewStatus = z.infer<typeof partnerReviewStatusSchema>;

// Only a DRAFT/IN_REVIEW version is "open" (refreshable, submittable,
// finalizable); FINALIZED/SUPERSEDED versions are immutable evidence.
export const PARTNER_REVIEW_OPEN_STATUSES = ["DRAFT", "IN_REVIEW"] as const satisfies readonly PartnerReviewStatus[];

// A review can never accumulate an unbounded revision chain.
export const MAX_PARTNER_REVIEW_VERSIONS = 200;

// --- Typed source references ------------------------------------------------
export const PARTNER_REVIEW_SOURCE_TYPES = ["assignment", "content", "analyticsSourceRecord", "campaign"] as const;
export const partnerReviewSourceTypeSchema = z.enum(PARTNER_REVIEW_SOURCE_TYPES);
export type PartnerReviewSourceType = z.infer<typeof partnerReviewSourceTypeSchema>;

export const partnerReviewSourceRefSchema = z.object({ type: partnerReviewSourceTypeSchema, ref: z.string().min(1) }).strict();
export type PartnerReviewSourceRef = z.infer<typeof partnerReviewSourceRefSchema>;

// --- Evidence snapshot -------------------------------------------------------
// Every value below is a raw, structured fact copied from canonical
// upstream records (or a boolean/count computed from those facts against
// the explicit evidence cutoff). There is no score, percentage, grade,
// or composite anywhere in this shape - a test walks every key of this
// schema and of a generated snapshot to keep that true.

const isoTimestamp = z.string().min(1);
const utcDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const evidenceThreadLinkSchema = z.object({ platform: z.string().min(1), url: z.string().min(1) }).strict();

export const evidenceThreadSchema = z
  .object({
    contentRef: z.string().min(1),
    status: z.string().min(1),
    currentRevisionNumber: z.number().int().min(0),
    openedAt: isoTimestamp,
    firstSubmittedAt: isoTimestamp.nullable(),
    lastSubmittedAt: isoTimestamp.nullable(),
    approvedAt: isoTimestamp.nullable(),
    cancelledAt: isoTimestamp.nullable(),
    linkCount: z.number().int().min(0),
    linkPlatforms: z.array(z.string().min(1)),
    links: z.array(evidenceThreadLinkSchema),
    // Derived from the canonical revision history (revisions submitted
    // beyond the first, plus a currently-open revision request). Exact
    // unless the thread was cancelled while a request was open - see
    // evidence-builder.ts's deriveRevisionRequestCount.
    revisionRequestCount: z.number().int().min(0),
    revisionRequestCountIsExact: z.boolean(),
  })
  .strict();
export type EvidenceThread = z.infer<typeof evidenceThreadSchema>;

export const evidenceProductionAssignmentSchema = z
  .object({
    assignmentRef: z.string().min(1),
    campaignRef: z.string().min(1),
    campaignName: z.string().min(1),
    status: z.string().min(1),
    dueAt: z.string().min(1).nullable(),
    // The authoritative event date used for period membership and which
    // source it came from (see evidence-builder.ts's resolveAssignmentEventDate).
    eventDate: utcDate,
    eventDateSource: z.enum(["dueAt", "createdAt"]),
    requiredCount: z.number().int().min(1).nullable(),
    formats: z.array(z.string()),
    platforms: z.array(z.string()),
    createdAt: isoTimestamp,
    completed: z.boolean(),
    cancelled: z.boolean(),
    thread: evidenceThreadSchema.nullable(),
  })
  .strict();
export type EvidenceProductionAssignment = z.infer<typeof evidenceProductionAssignmentSchema>;

export const evidenceComplianceAssignmentSchema = z
  .object({
    assignmentRef: z.string().min(1),
    dueAt: z.string().min(1).nullable(),
    submittedAt: isoTimestamp.nullable(),
    approvedAt: isoTimestamp.nullable(),
    // true/false when both a due instant and a first submission exist;
    // null when either is missing (never guessed).
    submittedBeforeDue: z.boolean().nullable(),
    approvedBeforeDue: z.boolean().nullable(),
    revisionRequestCount: z.number().int().min(0),
    revisionRequestCountIsExact: z.boolean(),
    threadStatus: z.string().min(1).nullable(),
    // Explicit boolean facts, computed against the snapshot's own
    // evidence cutoff.
    hasNoThread: z.boolean(),
    threadOpenWithNoLinks: z.boolean(),
    notCompletedPastDue: z.boolean(),
    completed: z.boolean(),
    cancelled: z.boolean(),
    assignmentStatus: z.string().min(1),
  })
  .strict();
export type EvidenceComplianceAssignment = z.infer<typeof evidenceComplianceAssignmentSchema>;

export const evidenceMetricValuesSchema = z.record(z.string(), z.number().nullable());

export const evidencePerformanceRecordSchema = z
  .object({
    sourceRecordRef: z.string().min(1),
    platform: z.string().min(1),
    matchedContentRef: z.string().min(1).nullable(),
    matchedAssignmentRef: z.string().min(1).nullable(),
    matchedCampaignRef: z.string().min(1).nullable(),
    matchedPartnerAccountRef: z.string().min(1).nullable(),
    postUrl: z.string().min(1).nullable(),
    postDateTime: isoTimestamp.nullable(),
    reportingPeriod: z.object({ start: z.string().min(1), end: z.string().min(1) }).strict(),
    provenance: z
      .object({
        batchRef: z.string().min(1),
        sheetName: z.string().min(1),
        sourceRowNumber: z.number().int().min(1),
        correctionRevision: z.number().int().min(1),
        matchState: z.string().min(1),
        matchEvidenceTier: z.string().min(1),
        matchReasonCode: z.string().min(1).nullable(),
        importedAt: isoTimestamp,
      })
      .strict(),
    // One entry per supported COUNT metric of the accepted Analytics
    // metric registry: the source-reported value, or null when the source
    // did not report it. Missing is never coerced to zero.
    metrics: evidenceMetricValuesSchema,
  })
  .strict();
export type EvidencePerformanceRecord = z.infer<typeof evidencePerformanceRecordSchema>;

export const evidenceMetricPresenceSchema = z.object({ metric: z.string().min(1), presentCount: z.number().int().min(0), missingCount: z.number().int().min(0) }).strict();

export const evidenceCompletenessSchema = z
  .object({
    truncated: z
      .object({
        assignmentScan: z.boolean(),
        assignmentsInPeriod: z.boolean(),
        analyticsScan: z.boolean(),
        analyticsRecordsInPeriod: z.boolean(),
      })
      .strict(),
    counts: z
      .object({
        assignmentsScanned: z.number().int().min(0),
        assignmentsInPeriod: z.number().int().min(0),
        threadsFound: z.number().int().min(0),
        analyticsRecordsScanned: z.number().int().min(0),
        analyticsRecordsInPeriod: z.number().int().min(0),
        analyticsRecordsExcludedNoReportingPeriod: z.number().int().min(0),
        analyticsRecordsExcludedUnparseableReportingPeriod: z.number().int().min(0),
        approvedContentWithoutAnalytics: z.number().int().min(0),
      })
      .strict(),
    // Typed reason codes (never free text) - see INCOMPLETE_REASON_CODES.
    incompleteReasons: z.array(z.string().min(1)),
  })
  .strict();

export const INCOMPLETE_REASON_CODES = [
  "assignment_scan_truncated",
  "assignments_in_period_truncated",
  "analytics_scan_truncated",
  "analytics_records_in_period_truncated",
  "approved_content_without_analytics",
  "analytics_records_without_reporting_period",
  "analytics_records_with_unparseable_reporting_period",
] as const;

// --- Commercial evidence (Step 13A.1 revised) -------------------------------------
// EVIDENCE ONLY: counts, variances, classifications, evaluations and refs.
// There is no monetary value and no financial calculation anywhere in this
// shape. Every Agreement-governed input (requirement,
// LFC/SFC rule, targets) arrives through the ONE replaceable seam in
// commercial-policy.ts and is copied verbatim - never invented, defaulted or
// entered manually inside Partner Reviews.
//
// The only payment-affecting marker is the boolean `affectsPayment`: on the
// deliverable / LFC-SFC sections it is true ONLY when the value was
// evaluated under an Agreement-governed rule; on a target it is the literal
// `false` (a target miss is a warning and can never change payment-affecting
// evidence).
//
// Old stored versions have no `commercial` key at all: the snapshot schema
// keeps it OPTIONAL (so a rewrite of an old immutable version stays
// byte-identical) and every reader goes through commercialOrNeutral()
// (commercial-builder.ts), which yields the explicit all-unavailable shape.

export const COMMERCIAL_EVIDENCE_POLICY_VERSION = 1;

// The ONLY supported qualifying units. Both are derived from canonical
// APPROVED Content evidence - never from raw submitted URLs or links of a
// non-APPROVED thread.
export const QUALIFYING_UNITS = ["approved_content_thread", "approved_current_link"] as const;
export const qualifyingUnitSchema = z.enum(QUALIFYING_UNITS);
export type QualifyingUnit = z.infer<typeof qualifyingUnitSchema>;

const governingIdentitySchema = z.object({ agreementRef: z.string().min(1), agreementVersion: z.number().int().min(1) }).strict();
export type EvidenceGoverningIdentity = z.infer<typeof governingIdentitySchema>;

export const DELIVERABLE_EVALUATIONS = ["met", "below_requirement", "exceeded", "unavailable"] as const;

export const evidenceCountUnitSchema = z.object({ assignmentRef: z.string().min(1), contentRef: z.string().min(1), unitCount: z.number().int().min(0) }).strict();
export type EvidenceCountUnit = z.infer<typeof evidenceCountUnitSchema>;

export const evidenceMonthlyDeliverableSchema = z
  .object({
    // Copied ONLY from the governing policy; null when there is none.
    requiredCount: z.number().int().min(0).nullable(),
    requirementSource: governingIdentitySchema.extend({ requirementSourceRef: z.string().min(1).nullable() }).strict().nullable(),
    qualifyingUnit: qualifyingUnitSchema.nullable(),
    actualQualifyingCount: z.number().int().min(0).nullable(),
    // Exactly the canonical units that were counted (approved threads).
    actualCountSources: z.object({ sourceType: z.enum(["content_thread", "content_link"]), units: z.array(evidenceCountUnitSchema) }).strict().nullable(),
    // actual - required (may be negative); null when unavailable.
    variance: z.number().int().nullable(),
    evaluation: z.enum(DELIVERABLE_EVALUATIONS),
    unavailableReason: z.string().min(1).nullable(),
    affectsPayment: z.boolean(),
  })
  .strict();
export type EvidenceMonthlyDeliverable = z.infer<typeof evidenceMonthlyDeliverableSchema>;

export const LFC_SFC_CLASSIFICATIONS = ["LFC", "SFC", "unclassified"] as const;

export const evidenceLfcSfcUnitSchema = z
  .object({
    assignmentRef: z.string().min(1),
    contentRef: z.string().min(1).nullable(),
    unitCount: z.number().int().min(0),
    classification: z.enum(LFC_SFC_CLASSIFICATIONS),
    // Traceable basis: the rule that classified it and the exact brief
    // format that matched (null when unclassified).
    basis: z.object({ ruleRef: z.string().min(1), matchedFormat: z.string().min(1).nullable() }).strict(),
  })
  .strict();
export type EvidenceLfcSfcUnit = z.infer<typeof evidenceLfcSfcUnitSchema>;

export const evidenceLfcSfcSchema = z
  .object({
    status: z.enum(["unavailable", "evaluated"]),
    unavailableReason: z.string().min(1).nullable(),
    ruleRef: z.string().min(1).nullable(),
    ruleSource: governingIdentitySchema.nullable(),
    // The qualifying unit the classification ran over, and where it came from.
    qualifyingUnit: qualifyingUnitSchema.nullable(),
    qualifyingUnitSource: z.enum(["agreement_requirement", "default_approved_content_thread"]).nullable(),
    lfcCount: z.number().int().min(0).nullable(),
    sfcCount: z.number().int().min(0).nullable(),
    unclassifiedCount: z.number().int().min(0).nullable(),
    units: z.array(evidenceLfcSfcUnitSchema),
    affectsPayment: z.boolean(),
  })
  .strict();
export type EvidenceLfcSfc = z.infer<typeof evidenceLfcSfcSchema>;

export const TARGET_EVALUATIONS = ["met", "not_met", "unavailable"] as const;

export const evidenceTargetSchema = z
  .object({
    targetRef: z.string().min(1),
    metricId: z.string().min(1),
    targetValue: z.number(),
    unit: z.string().min(1),
    comparison: z.literal("at_least"),
    actualValue: z.number().nullable(),
    evaluation: z.enum(TARGET_EVALUATIONS),
    unavailableReason: z.string().min(1).nullable(),
    provenance: z
      .object({
        sourceType: z.literal("analytics_source_record"),
        refs: z.array(z.string().min(1)),
        recordsWithMetric: z.number().int().min(0),
        recordsMissingMetric: z.number().int().min(0),
      })
      .strict(),
    // A target result is a WARNING only - the literal `false` makes it a
    // type error for a target to ever claim to change payment-affecting evidence.
    affectsPayment: z.literal(false),
  })
  .strict();
export type EvidenceTarget = z.infer<typeof evidenceTargetSchema>;

export const commercialEvidenceSchema = z
  .object({
    policyVersion: z.literal(COMMERCIAL_EVIDENCE_POLICY_VERSION),
    governingAgreement: governingIdentitySchema.nullable(),
    monthlyDeliverable: evidenceMonthlyDeliverableSchema,
    lfcSfc: evidenceLfcSfcSchema,
    targets: z.array(evidenceTargetSchema),
  })
  .strict();
export type CommercialEvidence = z.infer<typeof commercialEvidenceSchema>;

export const evidenceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    partnerRef: z.string().min(1),
    periodKey: z.string().regex(/^\d{4}-\d{2}$/),
    periodStart: utcDate,
    periodEnd: utcDate,
    evidenceCutoff: isoTimestamp,
    production: z
      .object({
        assignments: z.array(evidenceProductionAssignmentSchema),
      })
      .strict(),
    compliance: z
      .object({
        assignments: z.array(evidenceComplianceAssignmentSchema),
      })
      .strict(),
    performance: z
      .object({
        records: z.array(evidencePerformanceRecordSchema),
        metricPresence: z.array(evidenceMetricPresenceSchema),
        // The accepted registry's unsupported metric ids, listed
        // verbatim as "not available" - never synthesized or estimated.
        unavailableMetrics: z.array(z.string().min(1)),
        latestImportedAt: isoTimestamp.nullable(),
      })
      .strict(),
    // Optional ONLY for versions stored before commercial evidence existed
    // (see the comment above); every newly built snapshot carries it.
    commercial: commercialEvidenceSchema.optional(),
    completeness: evidenceCompletenessSchema,
    sourceRefs: z.array(partnerReviewSourceRefSchema),
  })
  .strict();
export type EvidenceSnapshot = z.infer<typeof evidenceSnapshotSchema>;

// --- Head document (partnerReviews/{reviewRef}) -----------------------------
// The head's own scope fields (ownerUid/regionIds/teamIds/partnerUid) are a
// point-in-time copy of the Partner's scope, refreshed on every mutation.
// They exist ONLY to serve bounded scoped list queries - the LIVE Partner's
// scope is the authority on every detail/mutation read.
export const partnerReviewHeadDocSchema = z.object({
  reviewRef: z.string().min(1),
  partnerRef: z.string().min(1),
  partnerUid: z.string().min(1),
  periodKey: z.string().regex(/^\d{4}-\d{2}$/),
  periodStart: utcDate,
  periodEnd: utcDate,

  // Highest version number ever created (never decreases).
  latestVersion: z.number().int().min(1),
  // Status of the version numbered latestVersion (denormalized for list filters).
  latestStatus: partnerReviewStatusSchema,
  currentFinalizedVersion: z.number().int().min(1).nullable(),
  // The single DRAFT/IN_REVIEW version, if any.
  openVersion: z.number().int().min(1).nullable(),
  // Optimistic-concurrency counter, bumped on every accepted mutation.
  docVersion: z.number().int().min(1),

  ownerUid: z.string().min(1).nullable().default(null),
  regionIds: z.array(z.string().min(1)).max(50).default([]),
  teamIds: z.array(z.string().min(1)).max(50).default([]),

  createdAt: isoTimestamp,
  createdByUserRef: z.string().min(1),
  updatedAt: isoTimestamp,
  updatedByUserRef: z.string().min(1),
});
export type PartnerReviewHeadDoc = z.infer<typeof partnerReviewHeadDocSchema>;

// --- Version document (partnerReviews/{reviewRef}/versions/{n}) ------------
export const partnerReviewVersionDocSchema = z.object({
  reviewRef: z.string().min(1),
  version: z.number().int().min(1),
  status: partnerReviewStatusSchema,
  docVersion: z.number().int().min(1),

  snapshot: evidenceSnapshotSchema,
  evidenceCutoff: isoTimestamp,
  sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  sourceRefs: z.array(partnerReviewSourceRefSchema),

  generatedAt: isoTimestamp,
  generatedByUserRef: z.string().min(1),
  lastRefreshedAt: isoTimestamp.nullable().default(null),
  lastRefreshedByUserRef: z.string().min(1).nullable().default(null),
  submittedAt: isoTimestamp.nullable().default(null),
  submittedByUserRef: z.string().min(1).nullable().default(null),
  finalizedAt: isoTimestamp.nullable().default(null),
  finalizedByUserRef: z.string().min(1).nullable().default(null),
  supersededAt: isoTimestamp.nullable().default(null),
  supersededByVersion: z.number().int().min(1).nullable().default(null),
  statusReason: z.string().min(1).max(1000).nullable().default(null),

  createdAt: isoTimestamp,
  createdByUserRef: z.string().min(1),
});
export type PartnerReviewVersionDoc = z.infer<typeof partnerReviewVersionDocSchema>;

// --- Append-only event history (partnerReviews/{reviewRef}/events/{id}) ----
export const PARTNER_REVIEW_EVENT_KINDS = ["generated", "refreshed", "submitted", "finalized", "revision_created", "superseded"] as const;
export const partnerReviewEventKindSchema = z.enum(PARTNER_REVIEW_EVENT_KINDS);
export type PartnerReviewEventKind = z.infer<typeof partnerReviewEventKindSchema>;

export const partnerReviewEventSchema = z.object({
  kind: partnerReviewEventKindSchema,
  version: z.number().int().min(1),
  actorUserRef: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  requestId: z.string().min(1),
  createdAt: isoTimestamp,
});
export type PartnerReviewEvent = z.infer<typeof partnerReviewEventSchema>;

// --- Freshness ---------------------------------------------------------------
// A small, closed, documented set (see fingerprint.ts's evaluateFreshness):
//  current               the snapshot matches current upstream evidence
//  refresh_available     an open (DRAFT/IN_REVIEW) version is behind upstream
//  revision_available    the current FINALIZED version is behind upstream and
//                        no revision is open
//  revision_in_progress  the current FINALIZED version is behind upstream but
//                        a revision is already open
//  evidence_incomplete   the snapshot matches upstream but a bounded read or
//                        a missing source made the evidence incomplete
//  superseded            a historical version - never compared
export const PARTNER_REVIEW_FRESHNESS_STATES = ["current", "refresh_available", "revision_available", "revision_in_progress", "evidence_incomplete", "superseded"] as const;
export type PartnerReviewFreshnessState = (typeof PARTNER_REVIEW_FRESHNESS_STATES)[number];

export type PartnerReviewFreshness = { state: PartnerReviewFreshnessState; incompleteReasons: string[] };

// --- Needs Review (derived, never persisted) ---------------------------------
export const NEEDS_REVIEW_REASONS = ["no_review", "draft_open", "in_review_open", "revision_available", "up_to_date", "no_evidence"] as const;
export type NeedsReviewReason = (typeof NEEDS_REVIEW_REASONS)[number];
export type NeedsReviewResult = { needsReview: boolean; reason: NeedsReviewReason };

// --- Result/error plumbing - same shape as Assignments' own -----------------
export type PartnerReviewsDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied";

export type PartnerReviewsServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "conflict" | "internal";

export type PartnerReviewsReadinessIssue = { code: string; message: string };

export type PartnerReviewsServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: PartnerReviewsServiceErrorCode; message: string; reason?: PartnerReviewsDenialReason; blockers?: PartnerReviewsReadinessIssue[] };

export type PartnerReviewsErrorResult = Extract<PartnerReviewsServiceResult<unknown>, { ok: false }>;

export function partnerReviewsUnauthorizedResult(reason: PartnerReviewsDenialReason): PartnerReviewsErrorResult {
  return { ok: false, code: "unauthorized", message: `Partner Reviews access denied (${reason}).`, reason };
}

export function partnerReviewsInvalidInputResult(message: string): PartnerReviewsErrorResult {
  return { ok: false, code: "invalid_input", message };
}

export function partnerReviewsNotFoundResult(message: string): PartnerReviewsErrorResult {
  return { ok: false, code: "not_found", message };
}

export function partnerReviewsStaleResult(message = "This review was changed elsewhere. Reload and try again."): PartnerReviewsErrorResult {
  return { ok: false, code: "stale_write", message };
}

export function partnerReviewsConflictResult(message: string): PartnerReviewsErrorResult {
  return { ok: false, code: "conflict", message };
}

export function partnerReviewsNotReadyResult(message: string, blockers: PartnerReviewsReadinessIssue[]): PartnerReviewsErrorResult {
  return { ok: false, code: "not_ready", message, blockers };
}
