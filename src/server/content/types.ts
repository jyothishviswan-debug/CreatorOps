import { z } from "zod";

import { platformIdentifierSchema } from "@/server/shared/platform";
export { normalizePlatformIdentifier, platformIdentifierSchema } from "@/server/shared/platform";
import { MAX_SUBMISSION_ROWS, submissionRecipientTypeSchema } from "@/server/assignments/external-submission-types";
export { submissionRecipientTypeSchema, type SubmissionRecipientType } from "@/server/assignments/external-submission-types";

// Step 11A.1: business-process correction, replacing Step 11A/11B's
// two-policy production/pre-publication-review/publication/completion
// state machine entirely. The real workflow: a Partner/Vendor submits
// already-published links through the existing public page, a Manager
// reviews the submitted links and either approves (closing the work) or
// requests revision (reopening the SAME public page/token for correction
// and resubmission), repeating until approved. Exactly ONE canonical
// Content thread exists per Assignment (never one per numbered required
// slot - that machinery is retired, see fulfillment-service.ts). Finance
// never calculates, gates, mutates, or owns anything here - unchanged.

// --- Status ----------------------------------------------------------
export const CONTENT_STATUSES = ["OPEN", "UNDER_REVIEW", "REVISION_REQUESTED", "APPROVED", "CANCELLED"] as const;
export const contentStatusSchema = z.enum(CONTENT_STATUSES);
export type ContentStatus = z.infer<typeof contentStatusSchema>;

// Only these two require a real, meaningful reason/comment - matches
// Assignment's own ASSIGNMENT_REASON_REQUIRED_STATUSES idiom exactly.
export const CONTENT_REASON_REQUIRED_STATUSES = ["REVISION_REQUESTED", "CANCELLED"] as const satisfies readonly ContentStatus[];

// --- Current links (denormalized copy of the latest revision's rows) ----
// Bounded by the same cap the public submission form itself already
// enforces (MAX_SUBMISSION_ROWS) - never a second, independently invented
// number. platformContentId is deliberately absent: the public form never
// collects it, so it never legitimately exists on this shape.
export const MAX_CONTENT_LINKS = MAX_SUBMISSION_ROWS;

export const contentLinkRowSchema = z
  .object({
    platform: platformIdentifierSchema,
    originalUrl: z.string().min(1).max(1000),
    normalizedUrl: z.string().min(1).max(1000),
    recordedAt: z.string().min(1),
  })
  .strict();
export type ContentLinkRow = z.infer<typeof contentLinkRowSchema>;

// --- Qualifying fulfillment (kept from Step 11A, computed at APPROVAL time now) --
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
// One canonical thread per Assignment - see fulfillment-service.ts /
// contentAssignmentThreadClaimDocSchema below for the uniqueness lock.
export const contentDocSchema = z.object({
  uid: z.string().min(1),
  contentRef: z.string().min(1),
  version: z.number().int().min(1),

  assignmentRef: z.string().min(1),
  campaignRef: z.string().min(1),
  partnerRef: z.string().min(1),

  status: contentStatusSchema,
  statusReason: z.string().min(1).max(1000).nullable().default(null),

  // 0 = no revision submitted yet. The first successful public submit
  // sets this to 1; each resubmit increments it.
  currentRevisionNumber: z.number().int().min(0),
  // The revision number a PENDING Manager decision must reference - set
  // to the just-submitted revision's number every time status becomes
  // UNDER_REVIEW. Used for the stale-decision check (same role
  // lastSubmittedVersion played in the retired two-policy model).
  reviewedRevisionNumber: z.number().int().min(1).nullable().default(null),

  // Denormalized copy of the LATEST revision's rows, for fast display /
  // public-page prefill without a second read.
  currentLinks: z.array(contentLinkRowSchema).max(MAX_CONTENT_LINKS).default([]),
  // Set once, on APPROVED - never used to decide approval itself. For the
  // one-thread-per-Assignment model an approved thread is essentially
  // always the Assignment's own required obligation, so this will almost
  // always compute to QUALIFYING_REQUIRED - the enum is kept for
  // forward-compatibility and honesty, not forced into a fake case.
  qualifyingFulfillment: qualifyingFulfillmentSchema.nullable().default(null),

  dueAt: z.string().min(1).nullable().default(null),

  // Creation timestamp - when the thread first became OPEN.
  openedAt: z.string().min(1),
  // Set once, first successful public submit - never overwritten.
  firstSubmittedAt: z.string().min(1).nullable().default(null),
  // Updated on every successful submit/resubmit.
  lastSubmittedAt: z.string().min(1).nullable().default(null),
  approvedAt: z.string().min(1).nullable().default(null),
  cancelledAt: z.string().min(1).nullable().default(null),

  // Scope projection - snapshotted from the owning Assignment at
  // creation, never independently assigned.
  ownerUid: z.string().min(1).nullable().default(null),
  regionIds: z.array(z.string().min(1)).max(50).default([]),
  teamIds: z.array(z.string().min(1)).max(50).default([]),

  createdAt: z.string().min(1),
  createdByUserRef: z.string().min(1),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type ContentDoc = z.infer<typeof contentDocSchema>;

// --- Immutable revision (content/{uid}/revisions/{uid}) -----------------
// Never overwritten, never deleted - each successful public submit
// creates exactly one new doc here, and content.currentLinks /
// currentRevisionNumber are denormalized FROM this on write.
export const contentRevisionRowSchema = z
  .object({
    platform: platformIdentifierSchema,
    originalUrl: z.string().min(1).max(1000),
    normalizedUrl: z.string().min(1).max(1000),
  })
  .strict();
export type ContentRevisionRow = z.infer<typeof contentRevisionRowSchema>;

export const contentRevisionDocSchema = z
  .object({
    uid: z.string().min(1),
    revisionNumber: z.number().int().min(1),
    rows: z.array(contentRevisionRowSchema).min(1).max(MAX_CONTENT_LINKS),
    // Carried from the submitting session, for audit.
    recipientType: submissionRecipientTypeSchema,
    recipientRef: z.string().min(1),
    submittedAt: z.string().min(1),
  })
  .strict();
export type ContentRevisionDoc = z.infer<typeof contentRevisionDocSchema>;

// --- One-canonical-thread-per-Assignment claim (contentAssignmentThreadClaims/{assignmentRef}) --
// Doc id IS the assignmentRef directly (one field, no composite key
// needed) - existence-is-the-lock, same idiom as
// assignmentActiveClaims/vendorPartnerActiveClaims. Permanent once
// created - there is no "release" concept, matching Assignment's own
// canonical-pair-claim precedent.
export const contentAssignmentThreadClaimDocSchema = z.object({
  assignmentRef: z.string().min(1),
  contentRef: z.string().min(1),
  contentUid: z.string().min(1),
  claimedAt: z.string().min(1),
});
export type ContentAssignmentThreadClaimDoc = z.infer<typeof contentAssignmentThreadClaimDocSchema>;

// --- Publication identity claim (contentPublicationClaims/{sha256(key)}) --
// Race-safe global uniqueness for a normalized publication URL identity.
// `key` is the pre-hash identity string, kept for auditability - the hash
// is only the doc id. Adapted for the revision model (section 14): a
// claim already owned by contentUid X may always be re-claimed/updated by
// contentUid X (that thread revising its own link across revisions is not
// a collision) - a claim owned by a DIFFERENT contentUid is still a hard
// collision. Never deleted, even when the URL is dropped from a later
// revision of its own thread (kept as a harmless orphan so an identical
// resubmission is always recognized as "already this thread's own").
export const contentPublicationClaimDocSchema = z.object({
  key: z.string().min(1),
  contentRef: z.string().min(1),
  contentUid: z.string().min(1),
  revisionNumber: z.number().int().min(1),
  claimedAt: z.string().min(1),
});
export type ContentPublicationClaimDoc = z.infer<typeof contentPublicationClaimDocSchema>;

// --- Events (content/{uid}/events/{uid}) - append-only ------------------
// Two distinct, honest Manager-decision kinds (approved/revision_requested)
// rather than one generic "review_decision" wrapper - matches section 9's
// own framing of exactly two Manager decisions.
export const CONTENT_EVENT_KINDS = ["created", "submitted", "approved", "revision_requested", "cancelled"] as const;
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
