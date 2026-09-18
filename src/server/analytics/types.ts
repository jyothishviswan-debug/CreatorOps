import { z } from "zod";

import { platformIdentifierSchema } from "@/server/shared/platform";

// Step 12A: the trusted Analytics ingestion substrate - governed bulk
// import, deterministic matching against canonical Content/Partner
// Account truth, provenance, and rebuildable read models. This is a
// brand-new domain; nothing here is reused from any other module's
// schema, though several shared primitives (platformIdentifierSchema,
// scoped-list.ts) are reused directly rather than re-derived.

// --- Target kind (Section 3) --------------------------------------------
// The two canonical record meanings a bulk import file is classified as -
// chosen explicitly by the actor when starting an import, never guessed
// from file content alone.
export const ANALYTICS_TARGET_KINDS = ["campaign_content", "channel_account"] as const;
export const analyticsTargetKindSchema = z.enum(ANALYTICS_TARGET_KINDS);
export type AnalyticsTargetKind = z.infer<typeof analyticsTargetKindSchema>;

// --- Reporting period -----------------------------------------------------
export const analyticsReportingPeriodSchema = z
  .object({
    start: z.string().min(1),
    end: z.string().min(1),
  })
  .strict();
export type AnalyticsReportingPeriod = z.infer<typeof analyticsReportingPeriodSchema>;

// --- Match state / evidence (Section 11-12) -------------------------------
export const ANALYTICS_MATCH_STATES = ["MATCHED", "UNMATCHED", "AMBIGUOUS"] as const;
export const analyticsMatchStateSchema = z.enum(ANALYTICS_MATCH_STATES);
export type AnalyticsMatchState = z.infer<typeof analyticsMatchStateSchema>;

// Content matching tiers - "platform_content_id" is a documented,
// always-implemented no-op today (Content never stores one - see
// content-matcher.ts's own comment); "published_url" is the real,
// load-bearing tier via the existing contentPublicationClaims index.
export const CONTENT_MATCH_EVIDENCE_TIERS = ["platform_content_id", "published_url", "none"] as const;
// Partner Account matching tiers.
export const CHANNEL_MATCH_EVIDENCE_TIERS = ["identity_claim", "bounded_scan", "none"] as const;
export const analyticsMatchEvidenceTierSchema = z.enum([...CONTENT_MATCH_EVIDENCE_TIERS, ...CHANNEL_MATCH_EVIDENCE_TIERS]);
export type AnalyticsMatchEvidenceTier = z.infer<typeof analyticsMatchEvidenceTierSchema>;

export const analyticsMatchEvidenceSchema = z
  .object({
    tier: analyticsMatchEvidenceTierSchema,
    value: z.string().min(1).max(1000).nullable(),
    // A safe, specific, typed reason code - never a raw stack trace, never
    // a bare "nothing found" collapsing several distinct causes together.
    // See content-matcher.ts / partner-account-matcher.ts for the closed
    // list of codes each side actually produces.
    reasonCode: z.string().min(1).max(80).nullable(),
    candidateCount: z.number().int().min(0),
  })
  .strict();
export type AnalyticsMatchEvidence = z.infer<typeof analyticsMatchEvidenceSchema>;

// --- Import batch header (analyticsImportBatches/{uid}) -------------------
export const ANALYTICS_BATCH_STATUSES = ["PENDING", "DRY_RUN_ONLY", "COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED"] as const;
export const analyticsBatchStatusSchema = z.enum(ANALYTICS_BATCH_STATUSES);
export type AnalyticsBatchStatus = z.infer<typeof analyticsBatchStatusSchema>;

export const analyticsSheetInventoryEntrySchema = z
  .object({
    sheetName: z.string().min(1).max(200),
    rowCount: z.number().int().min(0),
    recognizedAs: z.enum(["campaign_content", "channel_account", "unrecognized"]),
  })
  .strict();
export type AnalyticsSheetInventoryEntry = z.infer<typeof analyticsSheetInventoryEntrySchema>;

export const analyticsImportBatchDocSchema = z.object({
  uid: z.string().min(1),
  batchRef: z.string().min(1),
  targetKind: analyticsTargetKindSchema,
  sourceFilename: z.string().min(1).max(300),
  sourceMimeType: z.string().min(1).max(200),
  sourceExtension: z.string().min(1).max(20),
  sourceHash: z.string().min(1).max(128),
  supersedesBatchRef: z.string().min(1).nullable().default(null),
  reportingPeriod: analyticsReportingPeriodSchema.nullable().default(null),
  actorUserRef: z.string().min(1),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).nullable().default(null),
  completedAt: z.string().min(1).nullable().default(null),
  status: analyticsBatchStatusSchema,
  totalRows: z.number().int().min(0),
  actionableRows: z.number().int().min(0),
  matchedRows: z.number().int().min(0),
  unmatchedRows: z.number().int().min(0),
  ambiguousRows: z.number().int().min(0),
  invalidRows: z.number().int().min(0),
  duplicateUnchangedRows: z.number().int().min(0),
  failedRows: z.number().int().min(0),
  sourceSheetInventory: z.array(analyticsSheetInventoryEntrySchema).max(50).default([]),
  // Bounded, safe/sanitized messages only - never a raw stack trace or
  // filesystem path.
  safeErrorSummary: z.array(z.string().min(1).max(300)).max(50).default([]),
});
export type AnalyticsImportBatchDoc = z.infer<typeof analyticsImportBatchDocSchema>;

// --- Batch-level idempotency claim (analyticsImportBatchClaims/{sha256(sourceHash)}) --
// Existence-is-the-lock, same idiom as Content's own
// contentAssignmentThreadClaims/contentPublicationClaims - the
// concurrency-safe mechanism behind "two simultaneous execute calls
// against the exact same file only ever produce one batch".
export const analyticsImportBatchClaimDocSchema = z.object({
  sourceHash: z.string().min(1).max(128),
  batchUid: z.string().min(1),
  batchRef: z.string().min(1),
  claimedAt: z.string().min(1),
});
export type AnalyticsImportBatchClaimDoc = z.infer<typeof analyticsImportBatchClaimDocSchema>;

// --- Content/campaign source records (analyticsContentSourceRecords/{uid}) --
export const analyticsContentSourceRecordDocSchema = z.object({
  uid: z.string().min(1),
  sourceRef: z.string().min(1),
  batchRef: z.string().min(1),
  sheetName: z.string().min(1).max(200),
  sourceRowNumber: z.number().int().min(1),
  platform: platformIdentifierSchema,

  // Deterministic row identity - see import-pipeline.ts's
  // computeRowIdentityKey. Also the doc id itself (sha256 of this value),
  // kept as a plain field too for auditability, same "hash is only the
  // doc id, the pre-hash key is kept for audit" idiom as Content's own
  // contentPublicationClaimDocSchema.
  rowIdentityKey: z.string().min(1),

  // Raw, safe source values (audit trail) - never coerced.
  rawPostId: z.string().min(1).max(300).nullable(),
  rawPostUrl: z.string().min(1).max(1000).nullable(),
  rawPostType: z.string().min(1).max(120).nullable(),
  rawPostDateTime: z.string().min(1).max(120).nullable(),
  rawMediaUrl: z.string().min(1).max(1000).nullable(),
  rawCaption: z.string().min(1).max(2000).nullable(),
  rawComments: z.string().min(1).max(60).nullable(),
  rawLikes: z.string().min(1).max(60).nullable(),
  rawViews: z.string().min(1).max(60).nullable(),
  rawFollowers: z.string().min(1).max(60).nullable(),
  rawUsername: z.string().min(1).max(200).nullable(),
  rawEngagement: z.string().min(1).max(60).nullable(),
  rawAccountOrChannelName: z.string().min(1).max(200).nullable(),

  // Normalized canonical counterparts - missing ALWAYS stays `null`,
  // never coerced to `0` (see metric-registry.ts's parseSupportedMetric).
  normalizedUrl: z.string().min(1).max(1000).nullable(),
  postDateTimeIso: z.string().min(1).nullable(),
  comments: z.number().nullable(),
  likes: z.number().nullable(),
  views: z.number().nullable(),
  profileFollowers: z.number().nullable(),
  engagement: z.number().nullable(),

  reportingPeriod: analyticsReportingPeriodSchema.nullable().default(null),

  matchState: analyticsMatchStateSchema,
  matchEvidence: analyticsMatchEvidenceSchema,

  matchedContentRef: z.string().min(1).nullable().default(null),
  matchedAssignmentRef: z.string().min(1).nullable().default(null),
  matchedCampaignRef: z.string().min(1).nullable().default(null),
  matchedPartnerRef: z.string().min(1).nullable().default(null),
  // Separate, best-effort enrichment - see types.ts's own header comment
  // and content-matcher.ts. Its own failure/ambiguity never blocks or
  // downgrades an otherwise-successful Content match.
  matchedPartnerAccountRef: z.string().min(1).nullable().default(null),

  // Optimistic-concurrency-equivalent for correction-service.ts - bumped
  // by each accepted correction. Starts at 1 (this record's own original
  // match resolution counts as revision 1).
  correctionRevision: z.number().int().min(1).default(1),

  // Scope projection - denormalized from the MATCHED Content thread's own
  // ownerUid/regionIds/teamIds at commit time (never independently
  // assigned), same discipline as Content's own doc-level scope
  // projection from its owning Assignment. An UNMATCHED/AMBIGUOUS row
  // carries no scope evidence of its own (null/empty) and is therefore
  // only reachable by a GLOBAL-scoped actor via explorer-service.ts -
  // deliberately conservative, since an unresolved row's real ownership
  // is, by definition, not yet known.
  ownerUid: z.string().min(1).nullable().default(null),
  regionIds: z.array(z.string().min(1)).max(50).default([]),
  teamIds: z.array(z.string().min(1)).max(50).default([]),

  createdAt: z.string().min(1),
});
export type AnalyticsContentSourceRecordDoc = z.infer<typeof analyticsContentSourceRecordDocSchema>;

// --- Channel/account snapshot source records (analyticsChannelSourceRecords/{uid}) --
export const analyticsChannelSourceRecordDocSchema = z.object({
  uid: z.string().min(1),
  sourceRef: z.string().min(1),
  batchRef: z.string().min(1),
  sheetName: z.string().min(1).max(200),
  sourceRowNumber: z.number().int().min(1),
  platform: platformIdentifierSchema,

  rowIdentityKey: z.string().min(1),

  rawUsername: z.string().min(1).max(200).nullable(),
  rawProfileUrl: z.string().min(1).max(1000).nullable(),
  rawPlatformAccountId: z.string().min(1).max(200).nullable(),
  rawFollowers: z.string().min(1).max(60).nullable(),
  rawAccountOrChannelName: z.string().min(1).max(200).nullable(),

  normalizedProfileUrl: z.string().min(1).max(1000).nullable(),
  profileFollowers: z.number().nullable(),

  reportingPeriod: analyticsReportingPeriodSchema.nullable().default(null),

  matchState: analyticsMatchStateSchema,
  matchEvidence: analyticsMatchEvidenceSchema,

  matchedPartnerRef: z.string().min(1).nullable().default(null),
  matchedPartnerAccountRef: z.string().min(1).nullable().default(null),

  correctionRevision: z.number().int().min(1).default(1),

  // Scope projection - denormalized from the MATCHED Partner Account's
  // OWNING PARTNER (ownerUid/regionIds/teamIds), same rationale as the
  // content source record's own scope-projection comment above.
  ownerUid: z.string().min(1).nullable().default(null),
  regionIds: z.array(z.string().min(1)).max(50).default([]),
  teamIds: z.array(z.string().min(1)).max(50).default([]),

  createdAt: z.string().min(1),
});
export type AnalyticsChannelSourceRecordDoc = z.infer<typeof analyticsChannelSourceRecordDocSchema>;

// --- Append-only correction history (…SourceRecords/{uid}/corrections/{uid}) --
// Section 13: the previous match evidence/history is preserved here,
// never destructively overwritten - the parent record's own top-level
// matchState/matchedXRef fields DO get updated to reflect the new
// current resolution (see correction-service.ts).
export const analyticsSourceRecordCorrectionDocSchema = z.object({
  uid: z.string().min(1),
  recordKind: z.enum(["content", "channel"]),
  previousMatchState: analyticsMatchStateSchema,
  previousMatchEvidence: analyticsMatchEvidenceSchema,
  previousMatchedRefs: z.record(z.string(), z.string().nullable()),
  newMatchState: analyticsMatchStateSchema,
  newMatchEvidence: analyticsMatchEvidenceSchema,
  newMatchedRefs: z.record(z.string(), z.string().nullable()),
  reason: z.string().min(1).max(1000),
  actorUserRef: z.string().min(1),
  requestId: z.string().min(1),
  // The correctionRevision value the PARENT record was bumped to by this
  // correction (i.e. parent.correctionRevision after this write).
  correctionRevision: z.number().int().min(2),
  createdAt: z.string().min(1),
});
export type AnalyticsSourceRecordCorrectionDoc = z.infer<typeof analyticsSourceRecordCorrectionDocSchema>;

// --- Rebuildable global read-model snapshot (analyticsReadModelSnapshots/{uid}) --
// Section 14/22: explicitly GLOBAL/unscoped, computed only via
// rebuildAnalyticsReadModels() (internal/admin/test invocation only,
// never a public route) - NEVER trusted for a scoped read. Every ordinary
// scoped read (Explorer, live read-model queries) computes its own
// aggregate live from scope-constrained source records instead - see
// read-models.ts's own header comment.
export const analyticsReadModelSnapshotDocSchema = z.object({
  uid: z.string().min(1),
  scope: z.literal("GLOBAL"),
  computedAt: z.string().min(1),
  platformTotals: z.record(z.string(), z.record(z.string(), z.number().nullable())),
  sourceRecordCountsByPlatform: z.record(z.string(), z.number().int().min(0)),
  interactionsByPlatform: z.record(z.string(), z.number().nullable()),
  ingestionExceptionCounts: z.object({
    unmatched: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
  }),
  freshnessByPlatform: z.record(z.string(), z.string().nullable()),
});
export type AnalyticsReadModelSnapshotDoc = z.infer<typeof analyticsReadModelSnapshotDocSchema>;

// --- Row classification (Section 10) --------------------------------------
// Every row parsed out of an import file ends up with EXACTLY one of
// these nine terminal classifications - dry-run and execute both produce
// this same shape (see import-pipeline.ts's runAnalyticsImportPipeline).
// "ready" is a real, always-present classification for forward
// compatibility, but is not currently reachable under the two shipped
// adapters (both always attempt matching for every structurally valid,
// recognized, non-duplicate row) - documented honestly here and in the
// completion report, same treatment as the content-AMBIGUOUS branch (see
// content-matcher.ts).
export const ANALYTICS_ROW_CLASSIFICATIONS = ["ready", "warning", "unchanged", "duplicate", "invalid", "missing_dependency", "matched", "unmatched", "ambiguous"] as const;
export type AnalyticsRowClassification = (typeof ANALYTICS_ROW_CLASSIFICATIONS)[number];

// --- Result/error plumbing - mirrors Content's/Assignments' own exactly --
export type AnalyticsDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied";
export type AnalyticsServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "conflict" | "internal";

export type AnalyticsServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: AnalyticsServiceErrorCode; message: string; reason?: AnalyticsDenialReason };

export type AnalyticsErrorResult = Extract<AnalyticsServiceResult<unknown>, { ok: false }>;

export function analyticsUnauthorizedResult(reason: AnalyticsDenialReason): AnalyticsErrorResult {
  return { ok: false, code: "unauthorized", message: `Analytics access denied (${reason}).`, reason };
}
export function analyticsInvalidInputResult(message: string): AnalyticsErrorResult {
  return { ok: false, code: "invalid_input", message };
}
export function analyticsConflictResult(message: string): AnalyticsErrorResult {
  return { ok: false, code: "conflict", message };
}
export function analyticsNotFoundResult(message: string): AnalyticsErrorResult {
  return { ok: false, code: "not_found", message };
}
