import { z } from "zod";

// Step 10A: the canonical Assignment domain. Assignment = exactly one
// Partner-specific obligation for exactly one Campaign - campaign
// execution only, never Finance/Agreement/Payable/Invoice/Payment truth
// (that boundary is absolute - see AGENTS-facing authority doc section 1).
// This file follows the same contract shape as
// src/server/campaigns/types.ts deliberately, so the domains stay
// recognizably parallel without sharing state.

import { platformIdentifierArraySchema } from "@/server/shared/platform";
export { normalizePlatformIdentifier, platformIdentifierSchema } from "@/server/shared/platform";
import { reviewPolicySchema } from "@/server/campaigns/types";
export { reviewPolicySchema, type ReviewPolicy } from "@/server/campaigns/types";

// --- Assignment lifecycle -------------------------------------------------
// The compact, execution-level model - deliberately NOT Content/review
// states (SUBMITTED/APPROVED/REVISION_REQUESTED/POSTED/PUBLISHED belong to
// the future Content domain, never here). The full graph (which state may
// reach which) lives in @/server/authz/lifecycle's
// ASSIGNMENT_LIFECYCLE_TRANSITIONS - this list is just the closed set of
// valid values.
export const ASSIGNMENT_STATUSES = ["DRAFT", "ASSIGNED", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export const assignmentStatusSchema = z.enum(ASSIGNMENT_STATUSES);
export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;

// Only CANCELLED requires an explicit reason - matches Campaign's own
// CAMPAIGN_REASON_REQUIRED_STATUSES idiom exactly.
export const ASSIGNMENT_REASON_REQUIRED_STATUSES = ["CANCELLED"] as const satisfies readonly AssignmentStatus[];

export const MAX_ASSIGNMENT_PLATFORMS = 20;
export const assignmentPlatformsArraySchema = platformIdentifierArraySchema(MAX_ASSIGNMENT_PLATFORMS);

// --- Brief / obligation snapshot ------------------------------------------
// Captured ONCE at Assignment creation (campaignName/campaignObjective/
// reviewPolicy are a point-in-time copy of the owning Campaign) and never
// re-synced by a later Campaign edit - Step 10A section 3's own rule
// ("the issued brief snapshot must remain historically stable if Campaign
// later changes"). The caller-editable fields below (instructions through
// resourceLinks) may still be edited by staff while the Assignment itself
// is DRAFT (see editAssignmentBrief) - only the Campaign-derived fields
// are permanently frozen from the moment of creation.
export const assignmentBriefSchema = z
  .object({
    instructions: z.string().min(1).max(2000).nullable().default(null),
    contentRequirementSummary: z.string().min(1).max(1000).nullable().default(null),
    requiredCount: z.number().int().min(1).max(1000).nullable().default(null),
    formats: z.array(z.string().min(1).max(60)).max(20).default([]),
    // Required/allowed platforms for THIS Assignment - validated against
    // the owning Campaign's own platforms at both creation and edit time
    // (see assignment-service.ts). May be a subset of Campaign's platforms,
    // never a superset.
    platforms: assignmentPlatformsArraySchema.default([]),
    language: z.string().min(1).max(60).nullable().default(null),
    hashtags: z.array(z.string().min(1).max(60)).max(30).default([]),
    dueAt: z.string().min(1).nullable().default(null),
    // Step 10A.1 section 4: resource links are internal/reference by
    // default (fail closed) - a link only reaches the public external-
    // submission DTO when explicitly marked `shareExternally: true`.
    // Snapshotting a Campaign resource into an Assignment's brief never
    // makes it automatically public on its own; a staff member must
    // deliberately opt each individual link in.
    resourceLinks: z
      .array(z.object({ label: z.string().min(1).max(200), url: z.string().min(1).max(1000), shareExternally: z.boolean().default(false) }).strict())
      .max(20)
      .default([]),
    // Frozen Campaign-derived context - never edited directly, only set
    // once at creation from the Campaign's own state at that moment.
    reviewPolicy: reviewPolicySchema,
    campaignName: z.string().min(1).max(200),
    campaignObjective: z.string().min(1).max(2000).nullable().default(null),
  })
  .strict();
export type AssignmentBrief = z.infer<typeof assignmentBriefSchema>;

// --- Assignment document (assignments/{uid}) ------------------------------
export const assignmentDocSchema = z.object({
  uid: z.string().min(1),
  assignmentRef: z.string().min(1),
  version: z.number().int().min(1),

  campaignRef: z.string().min(1),
  partnerRef: z.string().min(1),
  // Selected Partner Account reference(s) - only where genuinely required
  // by the brief (e.g. "post from this exact channel"), never mandatory.
  partnerAccountRefs: z.array(z.string().min(1)).max(10).default([]),

  status: assignmentStatusSchema,
  statusReason: z.string().min(1).max(1000).nullable().default(null),

  brief: assignmentBriefSchema,

  // Internal owner/team/scope metadata - server-derived (snapshotted from
  // the owning Campaign at creation time), never accepted from the
  // client. See assignments-gate.ts's requireAssignmentInScope for how
  // this is used, and the Step 10A plan's own judgment call #4 for why
  // the snapshot source is Campaign only, never a Campaign/Partner union.
  ownerUid: z.string().min(1).nullable().default(null),
  regionIds: z.array(z.string().min(1)).max(50).default([]),
  teamIds: z.array(z.string().min(1)).max(50).default([]),

  createdAt: z.string().min(1),
  createdByUserRef: z.string().min(1),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type AssignmentDoc = z.infer<typeof assignmentDocSchema>;

// --- One-canonical-Assignment-per-(campaignRef, partnerRef) claim --------
// Step 10A section 2's hard invariant, enforced the exact same
// concurrency-safe way Vendors' own vendorPartnerActiveClaims enforces
// "at most one active Vendor per Partner" - the claim doc's EXISTENCE is
// the lock. Doc id is the deterministic composite `${campaignRef}:${partnerRef}`
// (see assignments/firestore.ts's assignmentActiveClaimsCollection). Unlike
// Vendor's claim (which is released when a relationship ends, freeing the
// Partner for a new one), this claim is PERMANENT once created - there is
// no "end/restore" concept for Assignment uniqueness, since "canonical"
// means exactly one Assignment ever exists for a given pair, regardless of
// that Assignment's own lifecycle state (a CANCELLED Assignment is still
// the one canonical historical record for that pair, not a freed slot).
export const assignmentActiveClaimDocSchema = z.object({
  campaignRef: z.string().min(1),
  partnerRef: z.string().min(1),
  assignmentRef: z.string().min(1),
  assignmentUid: z.string().min(1),
  claimedAt: z.string().min(1),
});
export type AssignmentActiveClaimDoc = z.infer<typeof assignmentActiveClaimDocSchema>;

// --- Append-only Assignment event/audit history (assignments/{uid}/events) --
export const ASSIGNMENT_EVENT_KINDS = [
  "created",
  "edited",
  "lifecycle_transitioned",
  "cancelled",
  "external_submission_link_issued",
  "external_submission_link_revoked",
  "external_links_submitted",
] as const;
export const assignmentEventKindSchema = z.enum(ASSIGNMENT_EVENT_KINDS);
export type AssignmentEventKind = z.infer<typeof assignmentEventKindSchema>;

export const assignmentEventSchema = z.object({
  kind: assignmentEventKindSchema,
  actorUserRef: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  requestId: z.string().min(1),
  createdAt: z.string().min(1),
});
export type AssignmentEvent = z.infer<typeof assignmentEventSchema>;

// --- Result/error plumbing - same shape as Campaigns'/Vendors' own -------
// "conflict" is reserved for the external-submission boundary (an
// already-used/revoked/expired token, or a Vendor recipient that is no
// longer the Partner's active Vendor) - Assignment creation itself never
// returns it (a repeated create for an already-claimed pair is always
// idempotent success, see assignment-service.ts's createAssignment).
export type AssignmentsDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied";

export type AssignmentsServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "conflict" | "internal";

export type AssignmentReadinessIssue = { code: string; message: string };

export type AssignmentsServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: AssignmentsServiceErrorCode; message: string; reason?: AssignmentsDenialReason; blockers?: AssignmentReadinessIssue[] };

export type AssignmentsErrorResult = Extract<AssignmentsServiceResult<unknown>, { ok: false }>;

export function assignmentsUnauthorizedResult(reason: AssignmentsDenialReason): AssignmentsErrorResult {
  return { ok: false, code: "unauthorized", message: `Assignments access denied (${reason}).`, reason };
}

export function assignmentsInvalidInputResult(message: string): AssignmentsErrorResult {
  return { ok: false, code: "invalid_input", message };
}

export function assignmentsNotReadyResult(message: string, blockers: AssignmentReadinessIssue[]): AssignmentsErrorResult {
  return { ok: false, code: "not_ready", message, blockers };
}

export function assignmentsConflictResult(message: string): AssignmentsErrorResult {
  return { ok: false, code: "conflict", message };
}
