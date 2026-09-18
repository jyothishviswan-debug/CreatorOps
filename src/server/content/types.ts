import { z } from "zod";

import { platformIdentifierSchema } from "@/server/shared/platform";
export { normalizePlatformIdentifier, platformIdentifierSchema } from "@/server/shared/platform";
import { reviewPolicySchema } from "@/server/campaigns/types";
export { reviewPolicySchema, type ReviewPolicy } from "@/server/campaigns/types";

// Step 11A: the canonical Content domain - production/review/revision/
// publication/fulfillment record. One Content belongs to exactly one
// Assignment; one Assignment may own many Content records. Never a
// canonical "Deliverable" entity (legacy reference mechanics only, never
// revived). Finance never calculates, gates, mutates, or owns anything
// here.

// --- Status ----------------------------------------------------------
export const CONTENT_STATUSES = ["PLANNED", "IN_PRODUCTION", "SUBMITTED", "CHANGES_REQUIRED", "APPROVED", "REJECTED", "POSTED", "COMPLETED", "CANCELLED"] as const;
export const contentStatusSchema = z.enum(CONTENT_STATUSES);
export type ContentStatus = z.infer<typeof contentStatusSchema>;

// Only these three require a real, meaningful reason/comment - matches
// Assignment's own ASSIGNMENT_REASON_REQUIRED_STATUSES idiom exactly.
export const CONTENT_REASON_REQUIRED_STATUSES = ["CHANGES_REQUIRED", "REJECTED", "CANCELLED"] as const satisfies readonly ContentStatus[];

// --- Publication evidence ---------------------------------------------
export const PUBLICATION_EVIDENCE_PROVENANCE = ["STAFF_RECORDED", "EXTERNAL_SUBMISSION"] as const;
export const publicationEvidenceProvenanceSchema = z.enum(PUBLICATION_EVIDENCE_PROVENANCE);

export const publicationEvidenceItemSchema = z
  .object({
    evidenceId: z.string().min(1),
    platform: platformIdentifierSchema,
    originalUrl: z.string().min(1).max(1000),
    normalizedUrl: z.string().min(1).max(1000),
    // Never inferred from the URL - only ever staff-supplied (Step 11A
    // section 11's own rule: "do not invent a platform content ID from a
    // URL unless a deterministic already-approved parser exists" - none
    // does).
    platformContentId: z.string().min(1).max(200).nullable().default(null),
    partnerAccountRef: z.string().min(1).nullable().default(null),
    publishedAt: z.string().min(1).nullable().default(null),
    recordedAt: z.string().min(1),
    recordedByUserRef: z.string().min(1),
    // "provenance/source kind" - STAFF_RECORDED today; EXTERNAL_SUBMISSION
    // is reserved for the later reconciliation operation (Step 11A
    // section 16 - designed for, not built, in this step).
    provenance: publicationEvidenceProvenanceSchema.default("STAFF_RECORDED"),
    sourceExternalSubmissionRef: z.string().min(1).nullable().default(null),
  })
  .strict();
export type PublicationEvidenceItem = z.infer<typeof publicationEvidenceItemSchema>;

export const MAX_PUBLICATION_EVIDENCE_ITEMS = 50;

// --- Qualifying fulfillment (set once, on completion) -------------------
export const CONTENT_FULFILLMENT_KINDS = ["QUALIFYING_REQUIRED", "QUALIFYING_EXTRA", "NON_QUALIFYING"] as const;
export const contentFulfillmentKindSchema = z.enum(CONTENT_FULFILLMENT_KINDS);
export type ContentFulfillmentKind = z.infer<typeof contentFulfillmentKindSchema>;

export const qualifyingFulfillmentSchema = z
  .object({
    kind: contentFulfillmentKindSchema,
    // Set only when kind === "NON_QUALIFYING" - a safe, typed reason code,
    // never a raw free-text explanation of internal logic.
    reasonCode: z.string().min(1).max(60).nullable().default(null),
    determinedAt: z.string().min(1),
  })
  .strict();
export type QualifyingFulfillment = z.infer<typeof qualifyingFulfillmentSchema>;

// --- Content root document (content/{uid}) -------------------------------
export const contentDocSchema = z.object({
  uid: z.string().min(1),
  contentRef: z.string().min(1),
  version: z.number().int().min(1),

  assignmentRef: z.string().min(1),
  campaignRef: z.string().min(1),
  partnerRef: z.string().min(1),
  partnerAccountRef: z.string().min(1).nullable().default(null),

  // Normalized (Step 11A section 4/11) via the shared platform normalizer.
  platform: platformIdentifierSchema,
  contentType: z.string().min(1).max(60),
  title: z.string().min(1).max(200).nullable().default(null),

  status: contentStatusSchema,
  statusReason: z.string().min(1).max(1000).nullable().default(null),

  // Immutable/effective review policy - a frozen point-in-time snapshot
  // from the owning Assignment at Content creation (which is itself
  // already frozen from the Campaign - Step 11A section 4's own rule: "a
  // later Campaign policy edit must never silently rewrite existing
  // Content review policy").
  reviewPolicy: reviewPolicySchema,

  // 0 = no version saved yet (the state every Content starts in at
  // PLANNED/IN_PRODUCTION before the first saveContentVersion call) - a
  // real, referenceable version is always >= 1.
  currentVersion: z.number().int().min(0),
  // The version a review decision must reference - null until the first
  // SUBMITTED transition. A review decision targeting any other version
  // is stale and rejected (Step 11A section 6's "stale decisions against
  // an old root/version must fail").
  lastSubmittedVersion: z.number().int().min(1).nullable().default(null),

  publicationEvidence: z.array(publicationEvidenceItemSchema).max(MAX_PUBLICATION_EVIDENCE_ITEMS).default([]),
  // Set once, only on COMPLETED - never used to decide completion itself.
  qualifyingFulfillment: qualifyingFulfillmentSchema.nullable().default(null),

  // Obligation-slot linkage. null = extra/non-obligation Content (Step
  // 11A section 8's own explicit "extra Content must not silently
  // increase Assignment fulfillment" rule) - a non-null value is the
  // canonical required-obligation slot index this Content claims (see
  // firestore.ts's contentRequiredSlotClaims collection).
  requiredSlotIndex: z.number().int().min(0).nullable().default(null),
  // Explicit replacement lineage (Step 11A section 15) - set only when
  // this Content was created specifically to satisfy a required slot
  // freed by a cancelled predecessor. Never used to destroy or rewrite
  // the predecessor's own history.
  supersedesContentRef: z.string().min(1).nullable().default(null),

  dueAt: z.string().min(1).nullable().default(null),

  // Lifecycle timestamps - each set exactly once, the first time the
  // corresponding transition is reached.
  productionStartedAt: z.string().min(1).nullable().default(null),
  submittedAt: z.string().min(1).nullable().default(null),
  approvedAt: z.string().min(1).nullable().default(null),
  postedAt: z.string().min(1).nullable().default(null),
  completedAt: z.string().min(1).nullable().default(null),
  cancelledAt: z.string().min(1).nullable().default(null),

  // Scope projection - snapshotted from the owning Assignment at creation,
  // never independently assigned (same "Assignment has no separately-
  // settable owner" idiom Assignment itself already uses for Campaign).
  ownerUid: z.string().min(1).nullable().default(null),
  regionIds: z.array(z.string().min(1)).max(50).default([]),
  teamIds: z.array(z.string().min(1)).max(50).default([]),

  createdAt: z.string().min(1),
  createdByUserRef: z.string().min(1),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type ContentDoc = z.infer<typeof contentDocSchema>;

// --- Immutable version snapshot (content/{uid}/versions/{uid}) ----------
export const contentVersionDocSchema = z
  .object({
    uid: z.string().min(1),
    versionNumber: z.number().int().min(1),
    captionText: z.string().min(1).max(5000).nullable().default(null),
    sourceUrl: z.string().min(1).max(1000).nullable().default(null),
    submissionNotes: z.string().min(1).max(2000).nullable().default(null),
    // Bounded, passive opaque refs only - never a new attachment system
    // (Step 11A section 7's own explicit prohibition). No resolution/
    // upload logic exists here or anywhere in this step.
    attachmentRefs: z.array(z.string().min(1).max(500)).max(20).default([]),
    createdAt: z.string().min(1),
    createdByUserRef: z.string().min(1),
  })
  .strict();
export type ContentVersionDoc = z.infer<typeof contentVersionDocSchema>;

// --- Required-obligation slot claim (contentRequiredSlotClaims/{assignmentRef}:{slotIndex}) --
// The claim doc's existence/status IS the lock - no query, no index.
// CLAIMED = a live (non-cancelled) required Content currently owns this
// slot. RELEASED = the Content that owned it was cancelled - the slot is
// available again, and the released claim's own contentRef becomes the
// next claimant's supersedesContentRef (Step 11A section 15's explicit
// "keep replacement lineage server-only and explicit" rule). Never
// deleted - matches Assignment's own "claim is permanent, never released
// in a way that destroys lineage" precedent, just with an extra RELEASED
// state layered on top instead of outright deletion.
export const CONTENT_SLOT_CLAIM_STATES = ["CLAIMED", "RELEASED"] as const;
export const contentSlotClaimStateSchema = z.enum(CONTENT_SLOT_CLAIM_STATES);

export const contentRequiredSlotClaimDocSchema = z.object({
  assignmentRef: z.string().min(1),
  slotIndex: z.number().int().min(0),
  contentRef: z.string().min(1),
  contentUid: z.string().min(1),
  state: contentSlotClaimStateSchema,
  claimedAt: z.string().min(1),
  releasedAt: z.string().min(1).nullable().default(null),
});
export type ContentRequiredSlotClaimDoc = z.infer<typeof contentRequiredSlotClaimDocSchema>;

// --- Publication identity claim (contentPublicationClaims/{sha256(key)}) --
// Race-safe global uniqueness for normalized publication URL identity and
// platform-content-ID identity, each independently. `key` is the
// pre-hash identity string, kept for auditability - the hash is only the
// doc id (a URL cannot be a doc id itself: it can contain "/"). Permanent
// once claimed (a published URL is irreversible evidence, matching
// Assignment's own external-submission-session precedent, not Partner
// Account's releasable-identity one).
export const contentPublicationClaimDocSchema = z.object({
  key: z.string().min(1),
  contentRef: z.string().min(1),
  contentUid: z.string().min(1),
  evidenceId: z.string().min(1),
  claimedAt: z.string().min(1),
});
export type ContentPublicationClaimDoc = z.infer<typeof contentPublicationClaimDocSchema>;

// --- Events (content/{uid}/events/{uid}) - append-only, review decisions
// fold in here as a strongly-typed event kind rather than a second
// collection (Step 11A section 5's own explicit "either a dedicated
// collection or a strongly typed append-only Content event record").
export const CONTENT_EVENT_KINDS = [
  "created",
  "production_started",
  "version_saved",
  "submitted",
  "review_decision",
  "publication_evidence_added",
  "posted",
  "completed",
  "cancelled",
] as const;
export const contentEventKindSchema = z.enum(CONTENT_EVENT_KINDS);
export type ContentEventKind = z.infer<typeof contentEventKindSchema>;

export const contentEventSchema = z.object({
  kind: contentEventKindSchema,
  actorUserRef: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  requestId: z.string().min(1),
  createdAt: z.string().min(1),
});
export type ContentEvent = z.infer<typeof contentEventSchema>;

// --- Result/error plumbing - mirrors Assignments' own exactly -----------
export type ContentDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied";

export type ContentServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "conflict" | "internal";

export type ContentReadinessIssue = { code: string; message: string };

export type ContentServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ContentServiceErrorCode; message: string; reason?: ContentDenialReason; blockers?: ContentReadinessIssue[] };

export type ContentErrorResult = Extract<ContentServiceResult<unknown>, { ok: false }>;

export function contentUnauthorizedResult(reason: ContentDenialReason): ContentErrorResult {
  return { ok: false, code: "unauthorized", message: `Content access denied (${reason}).`, reason };
}

export function contentInvalidInputResult(message: string): ContentErrorResult {
  return { ok: false, code: "invalid_input", message };
}

export function contentNotReadyResult(message: string, blockers: ContentReadinessIssue[]): ContentErrorResult {
  return { ok: false, code: "not_ready", message, blockers };
}

export function contentConflictResult(message: string): ContentErrorResult {
  return { ok: false, code: "conflict", message };
}
