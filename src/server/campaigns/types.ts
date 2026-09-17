import { z } from "zod";

// The one canonical, accepted audience-segmentation taxonomy - Discovery's
// Research stage owns it; Partners already reuses it verbatim (see
// partner-service.ts's own targetAudience field). Step 9A REVISED section
// 4 is explicit: Campaign targeting reuses this exact taxonomy, never a
// second Campaign-only one.
import { targetAudienceSchema } from "@/server/discovery/types";
export { TARGET_AUDIENCES, targetAudienceSchema, type TargetAudience } from "@/server/discovery/types";

// Step 9A.1: Campaign platform identity reuses Partner Account's own
// accepted platform-identifier contract (extracted to
// @/server/shared/platform) instead of a Campaign-local closed enum -
// see that module's own comment. Never a fixed catalog; a normalized,
// bounded, de-duplicated string array.
import { platformIdentifierArraySchema } from "@/server/shared/platform";
export { normalizePlatformIdentifier, platformIdentifierSchema } from "@/server/shared/platform";

// Step 9A: the canonical Campaign domain. Campaign owns programme-wide
// planning and default review policy ONLY - never Partner-specific
// obligation truth (that is the future Assignment's own job), never
// Content/Agreement/Finance/Analytics truth. This file follows the same
// contract shape as src/server/vendors/types.ts (lifecycle, result
// plumbing) deliberately, so the domains stay recognizably parallel
// without sharing state.

// --- Campaign lifecycle --------------------------------------------------
// Uses PLANNED, never a legacy/reference "READY" - see AGENTS-facing
// prompt's explicit terminology correction. The full graph (which state
// may reach which) lives in @/server/authz/lifecycle's
// CAMPAIGN_LIFECYCLE_TRANSITIONS - this list is just the closed set of
// valid values. No restore from ARCHIVED is ever implemented (frozen
// authority is explicit about this) - CANCELLED/ARCHIVED therefore never
// need a previousStatus field the way Vendor's ACTIVE/INACTIVE/ARCHIVED
// toggle does; only a statusReason is kept.
export const CAMPAIGN_STATUSES = ["DRAFT", "PLANNED", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED", "ARCHIVED"] as const;
export const campaignStatusSchema = z.enum(CAMPAIGN_STATUSES);
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;

// Targets that require an explicit reason - CANCELLED and ARCHIVED only.
export const CAMPAIGN_REASON_REQUIRED_STATUSES = ["CANCELLED", "ARCHIVED"] as const satisfies readonly CampaignStatus[];

// Step 9A.1: "at least one supported platform" is now checked structurally
// (a non-empty, normalized platform identifier - see readiness.ts),
// never against an invented catalog. MAX_CAMPAIGN_PLATFORMS bounds the
// array the same way every other bounded array field on this doc does.
export const MAX_CAMPAIGN_PLATFORMS = 20;
export const campaignPlatformsArraySchema = platformIdentifierArraySchema(MAX_CAMPAIGN_PLATFORMS);

export const REVIEW_POLICIES = ["REVIEW_REQUIRED", "NO_PREPOST_REVIEW"] as const;
export const reviewPolicySchema = z.enum(REVIEW_POLICIES);
export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;

// --- Targeting criteria (business intent, never authorization scope) ----
// Only fields already supported elsewhere on Partner (regions/languages/
// categories/targetAudience) plus platforms - never an invented
// dimension. targetAudience is the CANONICAL audience-segmentation
// criterion (Step 9A REVISED section 4), reusing Discovery/Partners'
// existing accepted taxonomy verbatim rather than a second Campaign-only
// one. Partner `tier` is deliberately NOT a targeting criterion here -
// REVISED section 4 explicitly withholds it pending separate approval.
// Distinct from the Campaign's own top-level `platforms` (which
// platforms this programme actually runs/publishes on) -
// criteria.platforms describes which Partners are being targeted (e.g.
// "Partners active on YouTube"), which is not always identical to where
// the Campaign itself publishes. Uses the EXACT same shared platform-
// identifier contract as the top-level field (Step 9A.1 section 3) -
// never a second representation.
export const campaignCriteriaSchema = z
  .object({
    targetAudience: targetAudienceSchema.nullable().default(null),
    regionIds: z.array(z.string().min(1)).max(50).default([]),
    languageIds: z.array(z.string().min(1)).max(50).default([]),
    categoryIds: z.array(z.string().min(1)).max(50).default([]),
    platforms: campaignPlatformsArraySchema.default([]),
  })
  .strict();
export type CampaignCriteria = z.infer<typeof campaignCriteriaSchema>;

// --- Resources / references (bounded, ordinary metadata only) -----------
// No file-upload abstraction in this repo cleanly fits an arbitrary
// Campaign resource (Discovery's/Vendors' own Drive integration is
// purpose-built for restricted KYC evidence, tied to a specific per-
// record subfolder scheme - reusing it here would misrepresent an
// ordinary shared resource as restricted evidence). Step 9A defers upload
// UI entirely and keeps this to safe metadata: a label/type/URL/
// description, never a secret, never restricted identity, never an
// Agreement contract file.
export const CAMPAIGN_RESOURCE_TYPES = ["LINK", "DOCUMENT", "BRIEF", "ASSET", "OTHER"] as const;
export const campaignResourceTypeSchema = z.enum(CAMPAIGN_RESOURCE_TYPES);
export type CampaignResourceType = z.infer<typeof campaignResourceTypeSchema>;

export const campaignResourceSchema = z
  .object({
    resourceRef: z.string().min(1),
    label: z.string().min(1).max(200),
    type: campaignResourceTypeSchema,
    url: z.string().min(1).max(1000),
    description: z.string().min(1).max(1000).nullable().default(null),
    addedAt: z.string().min(1),
    addedByUserRef: z.string().min(1),
  })
  .strict();
export type CampaignResource = z.infer<typeof campaignResourceSchema>;

// --- Campaign document (campaigns/{uid}) ---------------------------------
export const campaignDocSchema = z.object({
  uid: z.string().min(1),
  campaignRef: z.string().min(1),
  version: z.number().int().min(1),

  name: z.string().min(1).max(200),
  nameLower: z.string().min(1).max(200),
  objective: z.string().min(1).max(2000),

  status: campaignStatusSchema,
  statusReason: z.string().min(1).max(1000).nullable().default(null),

  // Which platforms this programme actually runs on - an operational
  // fact, not a targeting preference (see campaignCriteriaSchema's own
  // comment for the distinction). Normalized platform identifiers, same
  // shared contract Partner Account uses - never a closed enum.
  platforms: campaignPlatformsArraySchema.default([]),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  regionIds: z.array(z.string().min(1)).max(50).default([]),

  ownerUid: z.string().min(1).nullable().default(null),
  teamIds: z.array(z.string().min(1)).max(50).default([]),

  criteria: campaignCriteriaSchema,
  resources: z.array(campaignResourceSchema).max(50).default([]),

  // Campaign owns only the DEFAULT - a later Assignment must snapshot the
  // effective policy at the time it's created; changing this default must
  // never rewrite an existing Assignment's own snapshot. No Assignment
  // snapshot mechanism is implemented in Step 9A (prepare, do not
  // implement - see Step 9A section 15).
  defaultReviewPolicy: reviewPolicySchema,

  createdAt: z.string().min(1),
  createdByUserRef: z.string().min(1),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type CampaignDoc = z.infer<typeof campaignDocSchema>;

// --- Append-only Campaign event/audit history (campaigns/{uid}/events) --
export const CAMPAIGN_EVENT_KINDS = [
  "created",
  "edited",
  "owner_team_changed",
  "default_review_policy_changed",
  "resource_added",
  "resource_edited",
  "resource_removed",
  "lifecycle_transitioned",
  "cancelled",
  "archived",
] as const;
export const campaignEventKindSchema = z.enum(CAMPAIGN_EVENT_KINDS);
export type CampaignEventKind = z.infer<typeof campaignEventKindSchema>;

export const campaignEventSchema = z.object({
  kind: campaignEventKindSchema,
  actorUserRef: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  requestId: z.string().min(1),
  createdAt: z.string().min(1),
});
export type CampaignEvent = z.infer<typeof campaignEventSchema>;

// --- Readiness (derived, never a manually writable checkbox) ------------
export type CampaignReadinessIssue = { code: string; message: string };
export type CampaignReadinessResult = { ready: boolean; blockers: CampaignReadinessIssue[]; warnings: CampaignReadinessIssue[] };

// --- Result/error plumbing - same shape as Vendors'/Partners' own -------
export type CampaignsDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied";

export type CampaignsServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "internal";

export type CampaignsServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: CampaignsServiceErrorCode; message: string; reason?: CampaignsDenialReason; blockers?: CampaignReadinessIssue[] };

export type CampaignsErrorResult = Extract<CampaignsServiceResult<unknown>, { ok: false }>;

export function campaignsUnauthorizedResult(reason: CampaignsDenialReason): CampaignsErrorResult {
  return { ok: false, code: "unauthorized", message: `Campaigns access denied (${reason}).`, reason };
}

export function campaignsInvalidInputResult(message: string): CampaignsErrorResult {
  return { ok: false, code: "invalid_input", message };
}

export function campaignsNotReadyResult(message: string, blockers: CampaignReadinessIssue[]): CampaignsErrorResult {
  return { ok: false, code: "not_ready", message, blockers };
}
