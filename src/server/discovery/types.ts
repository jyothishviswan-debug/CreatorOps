import { z } from "zod";

// Step 6A: canonical Discovery domain contracts. Canonical terms only -
// "Discovery Lead" (pre-conversion prospect), "Partner" (individual
// creator/influencer), "Partner Account" (a Partner's platform/channel
// account), "Vendor" (agency/manager/representative/payee/business).
// `Creator` is never used as an entity name, and there is no
// Creator/Partner polymorphism - this is a greenfield model, not a port
// of any legacy reference schema.

// --- Lifecycle -------------------------------------------------------
// The frozen greenfield compact lifecycle (see
// src/server/authz/lifecycle.ts's LEAD_LIFECYCLE_TRANSITIONS for the
// actual transition table this enum's values must exactly match).
export const LEAD_LIFECYCLE_STATES = [
  "NEW",
  "RESEARCHING",
  "CONTACTED",
  "RESPONDED",
  "EVALUATING",
  "CONVERSION_READY",
  "CONVERTED",
  "WATCHLIST",
  "REJECTED",
  "DUPLICATE",
  "ARCHIVED",
] as const;
export const leadLifecycleSchema = z.enum(LEAD_LIFECYCLE_STATES);
export type LeadLifecycle = z.infer<typeof leadLifecycleSchema>;

export const LEAD_TERMINAL_STATES: readonly LeadLifecycle[] = ["CONVERTED", "DUPLICATE"];
export const LEAD_RESTORABLE_STATES: readonly LeadLifecycle[] = ["WATCHLIST", "REJECTED", "ARCHIVED"];

// --- Research policy ---------------------------------------------------
// Step 6A section 3: research completion requires exactly one approved
// Target Audience from this fixed list - no "Pan India", "Regional",
// "Local/City", "Other", or free-form value ever satisfies it. See
// research.ts's isResearchComplete, the one shared canonical function.
export const TARGET_AUDIENCES = ["India Alpha", "India 1", "India 2", "India 3", "India 4"] as const;
export const targetAudienceSchema = z.enum(TARGET_AUDIENCES);
export type TargetAudience = z.infer<typeof targetAudienceSchema>;

// Optional context only - MUST NOT participate in the completion gate
// (see research.ts). Free-form, deliberately unvalidated beyond a length
// bound.
export const researchSchema = z.object({
  targetAudience: targetAudienceSchema.nullable().default(null),
  language: z.string().min(1).max(80).optional(),
  location: z.string().min(1).max(120).optional(),
  category: z.string().min(1).max(80).optional(),
  notes: z.string().min(1).max(2000).optional(),
  followerCount: z.number().int().min(0).optional(),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type LeadResearch = z.infer<typeof researchSchema>;

// --- Review / shortlist -------------------------------------------------
export const REVIEW_OUTCOMES = ["SHORTLIST", "NEED_MORE_INFO", "WATCHLIST", "REJECT"] as const;
export const reviewOutcomeSchema = z.enum(REVIEW_OUTCOMES);
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

const ratingSchema = z.number().int().min(1).max(5);

export const reviewDimensionsSchema = z.object({
  contentQuality: ratingSchema.optional(),
  audienceQuality: ratingSchema.optional(),
  postingConsistency: ratingSchema.optional(),
  regionalRelevance: ratingSchema.optional(),
  languageMatch: ratingSchema.optional(),
  growthPotential: ratingSchema.optional(),
  communication: ratingSchema.optional(),
  overallConfidence: ratingSchema.optional(),
});
export type ReviewDimensions = z.infer<typeof reviewDimensionsSchema>;

export const reviewSchema = z.object({
  outcome: reviewOutcomeSchema,
  dimensions: reviewDimensionsSchema.default({}),
  reason: z.string().min(1).max(1000).optional(),
  actorUserRef: z.string().min(1),
  createdAt: z.string().min(1),
});
export type LeadReview = z.infer<typeof reviewSchema>;

// --- Outreach / response -------------------------------------------------
// Step 6A section 4: a single evidence shape covers both "record
// outreach/contact" and "record meaningful response" (section 8's two
// list entries) - direction distinguishes an outbound attempt from an
// inbound reply, and `meaningfulResponse` (operator-supplied judgment,
// never inferred) marks an inbound entry as the one that advances the
// lifecycle to RESPONDED. The timestamp is always server-captured -
// never accepted from the caller.
export const OUTREACH_DIRECTIONS = ["OUTBOUND", "INBOUND"] as const;
export const outreachDirectionSchema = z.enum(OUTREACH_DIRECTIONS);
export type OutreachDirection = z.infer<typeof outreachDirectionSchema>;

export const outreachEntrySchema = z.object({
  direction: outreachDirectionSchema,
  channel: z.string().min(1).max(60),
  summary: z.string().min(1).max(1000),
  outcome: z.string().min(1).max(120),
  notes: z.string().min(1).max(2000).optional(),
  supportingReference: z.string().min(1).max(300).optional(),
  nextFollowUpAt: z.string().min(1).optional(),
  meaningfulResponse: z.boolean().default(false),
  actorUserRef: z.string().min(1),
  createdAt: z.string().min(1),
});
export type LeadOutreachEntry = z.infer<typeof outreachEntrySchema>;

// Bounded, non-history summary kept on the root Lead doc so readiness/UI
// can answer "has outreach happened" without scanning the events
// subcollection - the full record of every attempt lives there instead
// (see lead-events.ts).
export const outreachSummarySchema = z.object({
  totalCount: z.number().int().min(0),
  lastDirection: outreachDirectionSchema,
  lastChannel: z.string().min(1),
  lastOutcome: z.string().min(1),
  lastAt: z.string().min(1),
  nextFollowUpAt: z.string().min(1).nullable().default(null),
});
export type LeadOutreachSummary = z.infer<typeof outreachSummarySchema>;

// --- Commercial / agreement evidence -------------------------------------
// Negotiation/commercial alignment is conversion evidence. Discovery
// agreement evidence is operational only - it must never become
// canonical Finance Agreement truth (that's a distinct future domain).
export const commercialEvidenceSchema = z.object({
  negotiationSummary: z.string().min(1).max(2000).optional(),
  alignmentConfirmed: z.boolean(),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type LeadCommercialEvidence = z.infer<typeof commercialEvidenceSchema>;

export const discoveryAgreementEvidenceSchema = z.object({
  summary: z.string().min(1).max(2000).optional(),
  referenceUrl: z.string().min(1).max(500).optional(),
  confirmedAt: z.string().min(1).nullable().default(null),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type LeadDiscoveryAgreementEvidence = z.infer<typeof discoveryAgreementEvidenceSchema>;

// --- Asset decision -------------------------------------------------------
// Exactly three outcomes. NEW_ACCOUNT records only the decision/pending
// setup requirement - it must never fabricate a URL, handle, or Partner
// Account (enforced in conversion-service.ts, not just here).
export const ASSET_DECISIONS = ["MAINTAIN_EXISTING", "TRANSFER_AND_MAINTAIN", "NEW_ACCOUNT"] as const;
export const assetDecisionKindSchema = z.enum(ASSET_DECISIONS);
export type AssetDecisionKind = z.infer<typeof assetDecisionKindSchema>;

export const assetDecisionSchema = z.object({
  decision: assetDecisionKindSchema,
  existingPartnerAccountRef: z.string().min(1).optional(),
  notes: z.string().min(1).max(1000).optional(),
  decidedAt: z.string().min(1),
  decidedByUserRef: z.string().min(1),
});
export type LeadAssetDecision = z.infer<typeof assetDecisionSchema>;

// --- Duplicate detection --------------------------------------------------
// A failed lookup is "unknown", never silently "none" - see
// duplicate-check.ts. "confirmed" blocks conversion; "possible" is a
// readiness warning only.
export const DUPLICATE_STATUSES = ["unknown", "none", "possible", "confirmed"] as const;
export const duplicateStatusSchema = z.enum(DUPLICATE_STATUSES);
export type DuplicateStatus = z.infer<typeof duplicateStatusSchema>;

export const DUPLICATE_MATCH_TYPES = ["email", "phone", "profileUrl", "handle"] as const;
export const duplicateMatchTypeSchema = z.enum(DUPLICATE_MATCH_TYPES);
export type DuplicateMatchType = z.infer<typeof duplicateMatchTypeSchema>;

export const DUPLICATE_MATCH_SOURCES = ["lead", "partner", "partner_account"] as const;
export const duplicateMatchSourceSchema = z.enum(DUPLICATE_MATCH_SOURCES);
export type DuplicateMatchSource = z.infer<typeof duplicateMatchSourceSchema>;

export const duplicateMatchSchema = z.object({
  type: duplicateMatchTypeSchema,
  source: duplicateMatchSourceSchema,
  // Opaque ref only (leadRef/partnerRef/partnerAccountRef) - never a raw
  // Firestore id or uid.
  ref: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]),
});
export type DuplicateMatch = z.infer<typeof duplicateMatchSchema>;

export const duplicateCheckResultSchema = z.object({
  status: duplicateStatusSchema,
  matches: z.array(duplicateMatchSchema).max(10).default([]),
  checkedAt: z.string().min(1),
});
export type DuplicateCheckResult = z.infer<typeof duplicateCheckResultSchema>;

// --- Conversion -----------------------------------------------------------
export const conversionRecordSchema = z.object({
  convertedAt: z.string().min(1),
  convertedByUserRef: z.string().min(1),
  partnerRef: z.string().min(1),
  partnerAccountRef: z.string().min(1).nullable().default(null),
  idempotencyKey: z.string().min(1),
});
export type LeadConversionRecord = z.infer<typeof conversionRecordSchema>;

// --- Source / provenance ---------------------------------------------------
export const LEAD_SOURCE_TYPES = ["research", "referral", "inbound", "other"] as const;
export const leadSourceTypeSchema = z.enum(LEAD_SOURCE_TYPES);
export type LeadSourceType = z.infer<typeof leadSourceTypeSchema>;

export const leadSourceSchema = z.object({
  type: leadSourceTypeSchema,
  note: z.string().min(1).max(300).optional(),
});
export type LeadSource = z.infer<typeof leadSourceSchema>;

// --- The canonical Lead document ------------------------------------------
// Server-only shape (Firestore doc data). `uid` is the Firestore document
// id, never sent to the browser - `leadRef` is the sole opaque handle a
// client may hold (same pattern as users/{uid} + userRef, Step 5A).
// `ownerUid`/`managerUid` are real Firebase uids for scope-matching and
// live validity checks only - DTOs expose ownerRef/managerRef (userRef)
// instead, never the raw uid. No unbounded history arrays live here -
// only bounded, single "current state" objects; full evidence history is
// the leads/{uid}/events append-only subcollection (see lead-events.ts).
export const leadDocSchema = z.object({
  uid: z.string().min(1),
  leadRef: z.string().min(1),
  version: z.number().int().min(1),

  lifecycle: leadLifecycleSchema,
  previousLifecycle: leadLifecycleSchema.nullable().default(null),
  lifecycleReason: z.string().min(1).max(1000).nullable().default(null),

  displayName: z.string().min(1).max(200),
  // Kept in sync with displayName on every write - the searchable field
  // (Step 6B's Workspace "search by name") for the same reason
  // users/{uid}.email is stored lowercase: a Firestore prefix-range
  // query is byte-order/case-sensitive, so case-insensitive search needs
  // its own normalized field, never a client-side filter over a
  // preloaded page.
  displayNameLower: z.string().min(1).max(200),
  email: z.string().min(1).max(300).nullable().default(null),
  phone: z.string().min(1).max(40).nullable().default(null),
  profileUrl: z.string().min(1).max(500).nullable().default(null),
  platform: z.string().min(1).max(60).nullable().default(null),
  handle: z.string().min(1).max(120).nullable().default(null),

  source: leadSourceSchema,

  // Scope-relevant dimensions (also the Firestore query filter fields -
  // see firestore.ts's listLeads). No postal address anywhere on this
  // model.
  region: z.string().min(1).max(80).nullable().default(null),
  teamId: z.string().min(1).max(120).nullable().default(null),
  ownerUid: z.string().min(1).nullable().default(null),

  research: researchSchema.nullable().default(null),
  latestReview: reviewSchema.nullable().default(null),
  outreachSummary: outreachSummarySchema.nullable().default(null),
  respondedAt: z.string().min(1).nullable().default(null),
  commercial: commercialEvidenceSchema.nullable().default(null),
  discoveryAgreement: discoveryAgreementEvidenceSchema.nullable().default(null),
  assetDecision: assetDecisionSchema.nullable().default(null),

  managerUid: z.string().min(1).nullable().default(null),

  // Non-sensitive boolean marker only - never any actual KYC value. Kept
  // in sync exclusively by kyc-service.ts's write path.
  kycPackageComplete: z.boolean().default(false),

  duplicateCheck: duplicateCheckResultSchema.nullable().default(null),
  conversion: conversionRecordSchema.nullable().default(null),

  createdAt: z.string().min(1),
  createdByUserRef: z.string().min(1),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type LeadDoc = z.infer<typeof leadDocSchema>;

// --- Restricted KYC (physically/logically separate collection) -----------
// Conversion-critical KYC package. Lives in its own top-level collection
// (leadRestrictedKyc/{leadUid}, see firestore.ts's COLLECTIONS), never
// merged into the Lead doc, never returned by any ordinary Lead read.
// Reachable only through kyc-service.ts, gated by BOTH the manage_kyc
// action and the "discovery_kyc" sensitive-access category. No postal
// address, no address proof - Step 6A section 5 is explicit that there
// is no hidden address-readiness blocker.
export const leadRestrictedKycDocSchema = z.object({
  uid: z.string().min(1),
  version: z.number().int().min(1),
  email: z.string().min(1).max(300),
  aadhaar: z.object({ number: z.string().min(1).max(40), evidenceRef: z.string().min(1).max(300) }),
  pan: z.object({ number: z.string().min(1).max(20), evidenceRef: z.string().min(1).max(300) }),
  bank: z.object({
    accountHolderName: z.string().min(1).max(200),
    accountNumber: z.string().min(1).max(40),
    ifsc: z.string().min(1).max(20),
    bankName: z.string().min(1).max(120),
    proofRef: z.string().min(1).max(300),
  }),
  gst: z.object({
    applicable: z.boolean(),
    number: z.string().min(1).max(30).optional(),
    certificateRef: z.string().min(1).max(300).optional(),
  }),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type LeadRestrictedKycDoc = z.infer<typeof leadRestrictedKycDocSchema>;

// --- Canonical Partner / Partner Account (conversion targets) ------------
// Deliberately minimal - Step 6A only needs enough of a canonical
// Partner/Partner Account model for controlled conversion to create or
// reuse one; the full Partners domain (CRUD, UI, relationships) is out
// of scope here. No Creator/Partner polymorphism, no Vendor created by
// ordinary individual-Partner conversion.
export const partnerDocSchema = z.object({
  uid: z.string().min(1),
  partnerRef: z.string().min(1),
  version: z.number().int().min(1),
  displayName: z.string().min(1).max(200),
  email: z.string().min(1).max(300).nullable().default(null),
  phone: z.string().min(1).max(40).nullable().default(null),
  region: z.string().min(1).max(80).nullable().default(null),
  // Immutable provenance/snapshot from the Discovery Lead this Partner
  // was created from - preserved forever, never edited after conversion.
  sourceDiscovery: z.object({
    leadRef: z.string().min(1),
    convertedAt: z.string().min(1),
    snapshot: z.object({
      displayName: z.string().min(1),
      email: z.string().min(1).nullable(),
      phone: z.string().min(1).nullable(),
      profileUrl: z.string().min(1).nullable(),
      platform: z.string().min(1).nullable(),
      handle: z.string().min(1).nullable(),
      source: leadSourceSchema,
    }),
  }),
  // NEW_ACCOUNT conversions never fabricate a Partner Account - this
  // records the pending setup requirement instead, on the Partner
  // itself, so it isn't lost once the Lead's own record is CONVERTED.
  pendingPartnerAccountSetup: z.boolean().default(false),
  createdAt: z.string().min(1),
  createdByUserRef: z.string().min(1),
});
export type PartnerDoc = z.infer<typeof partnerDocSchema>;

export const partnerAccountDocSchema = z.object({
  uid: z.string().min(1),
  partnerAccountRef: z.string().min(1),
  version: z.number().int().min(1),
  partnerRef: z.string().min(1),
  platform: z.string().min(1).max(60),
  handle: z.string().min(1).max(120).nullable().default(null),
  profileUrl: z.string().min(1).max(500).nullable().default(null),
  assetPath: assetDecisionKindSchema,
  createdAt: z.string().min(1),
  createdByUserRef: z.string().min(1),
});
export type PartnerAccountDoc = z.infer<typeof partnerAccountDocSchema>;

// --- Append-only Lead event/evidence history (leads/{uid}/events) --------
export const LEAD_EVENT_KINDS = [
  "created",
  "edited",
  "lifecycle_transitioned",
  "lifecycle_restored",
  "research_saved",
  "review_recorded",
  "outreach_recorded",
  "commercial_saved",
  "agreement_saved",
  "asset_decision_saved",
  "manager_assigned",
  "kyc_updated",
  "duplicate_checked",
  "converted",
] as const;
export const leadEventKindSchema = z.enum(LEAD_EVENT_KINDS);
export type LeadEventKind = z.infer<typeof leadEventKindSchema>;

const safeMetadataSchema = z.record(z.string(), z.unknown()).nullable();

export const leadEventSchema = z.object({
  kind: leadEventKindSchema,
  actorUserRef: z.string().min(1),
  // Free-form but redacted the same way authz/audit.ts redacts - never a
  // PAN/Aadhaar/bank/IFSC/token/restricted-document value (kyc_updated
  // events record ONLY that a package was saved, never its contents).
  metadata: safeMetadataSchema,
  requestId: z.string().min(1),
  createdAt: z.string().min(1),
});
export type LeadEvent = z.infer<typeof leadEventSchema>;

// --- Service result plumbing (mirrors src/server/administration/types.ts,
// kept as its own copy since Discovery's denial reasons/error codes are
// genuinely different from Administration's) -------------------------
export type DiscoveryDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied" | "sensitive_denied";

export type DiscoveryServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "conflict" | "not_ready" | "internal";

export type DiscoveryServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: DiscoveryServiceErrorCode; message: string; reason?: DiscoveryDenialReason; blockers?: ReadinessIssue[] };

// The error branch alone, with no `T` - structurally assignable to
// DiscoveryServiceResult<T> for ANY T (it never touches `data`), so
// these two builders can be returned directly from a function declared
// to return Promise<DiscoveryServiceResult<WhateverItActuallyIs>>
// without needing an explicit type argument at every call site.
export type DiscoveryErrorResult = Extract<DiscoveryServiceResult<unknown>, { ok: false }>;

export function discoveryUnauthorizedResult(reason: DiscoveryDenialReason): DiscoveryErrorResult {
  return { ok: false, code: "unauthorized", message: `Discovery access denied (${reason}).`, reason };
}

export function discoveryInvalidInputResult(message: string): DiscoveryErrorResult {
  return { ok: false, code: "invalid_input", message };
}

// --- Readiness --------------------------------------------------------
export type ReadinessIssue = { code: string; message: string };
export type ReadinessResult = { ready: boolean; blockers: ReadinessIssue[]; warnings: ReadinessIssue[] };
