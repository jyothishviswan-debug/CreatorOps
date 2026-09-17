import { z } from "zod";

import { assetDecisionKindSchema, leadSourceSchema, type AssetDecisionKind } from "@/server/discovery/types";

// Step 7A: the canonical Partner + Partner Account domain. Partner = one
// individual creator/influencer/person. Partner Account = one platform/
// channel account belonging to one Partner (1:N). Vendor (a separate
// agency/manager/representative/payee entity) is explicitly out of scope
// here - never modeled inside Partner.
//
// This is the SAME schema used by both Discovery conversion
// (conversion-service.ts) and direct Partner/account creation - there is
// deliberately no separate "conversion-only" Partner shape.

// --- Partner lifecycle -------------------------------------------------
// ACTIVE <-> INACTIVE is a freely reversible operational toggle (ordinary
// `edit`-level access). BLACKLISTED/ARCHIVED are controlled governance
// states, only reached through their own dedicated trusted operations
// (reason + version precondition + dependency check + immutable event -
// never through the plain status toggle). `previousStatus` is what a
// restore returns to - conservative and history-preserving, mirroring
// Discovery's own previousLifecycle/restore design exactly.
export const PARTNER_STATUSES = ["ACTIVE", "INACTIVE", "BLACKLISTED", "ARCHIVED"] as const;
export const partnerStatusSchema = z.enum(PARTNER_STATUSES);
export type PartnerStatus = z.infer<typeof partnerStatusSchema>;

// Governance states reached only through blacklistPartner/archivePartner,
// never through the plain ACTIVE<->INACTIVE toggle.
export const PARTNER_GOVERNANCE_STATUSES = ["BLACKLISTED", "ARCHIVED"] as const satisfies readonly PartnerStatus[];

export const partnerAccountStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
export type PartnerAccountStatus = z.infer<typeof partnerAccountStatusSchema>;

// --- Partner document (partners/{uid}) ----------------------------------
export const partnerDocSchema = z.object({
  uid: z.string().min(1),
  partnerRef: z.string().min(1),
  version: z.number().int().min(1),

  displayName: z.string().min(1).max(200),
  // Kept in sync with displayName on every write - same searchable-field
  // idiom as Discovery's Lead displayNameLower.
  displayNameLower: z.string().min(1).max(200),
  legalName: z.string().min(1).max(200).nullable().default(null),

  status: partnerStatusSchema,
  previousStatus: partnerStatusSchema.nullable().default(null),
  statusReason: z.string().min(1).max(1000).nullable().default(null),

  regionIds: z.array(z.string().min(1)).max(50).default([]),
  languageIds: z.array(z.string().min(1)).max(50).default([]),
  categoryIds: z.array(z.string().min(1)).max(50).default([]),
  tier: z.string().min(1).max(60).nullable().default(null),
  priority: z.string().min(1).max(60).nullable().default(null),

  // Safe contact data only - never restricted financial/KYC values (see
  // restrictedFinancialIdentityDocSchema below for those).
  email: z.string().min(1).max(300).nullable().default(null),
  phone: z.string().min(1).max(40).nullable().default(null),

  ownerUid: z.string().min(1).nullable().default(null),
  teamIds: z.array(z.string().min(1)).max(50).default([]),

  // Discovery provenance - every Lead this Partner has ever originated
  // from or been linked to (ordinarily just one, from conversion; plural
  // so a later reconciliation/merge workflow never has to squeeze
  // multiple provenance facts into one field).
  originLeadRefs: z.array(z.string().min(1)).max(20).default([]),
  // The richer conversion-time snapshot, preserved verbatim - never
  // rewritten after conversion, never used to re-derive ordinary fields.
  sourceDiscovery: z
    .object({
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
    })
    .nullable()
    .default(null),
  // NEW_ACCOUNT conversions never fabricate a Partner Account - this
  // records the pending setup requirement instead, resolved later by a
  // real createPartnerAccount call (never auto-cleared by anything else).
  pendingPartnerAccountSetup: z.boolean().default(false),

  createdAt: z.string().min(1),
  createdByUserRef: z.string().min(1),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type PartnerDoc = z.infer<typeof partnerDocSchema>;

// --- Partner Account document (partnerAccounts/{uid}) -------------------
export const partnerAccountDocSchema = z.object({
  uid: z.string().min(1),
  partnerAccountRef: z.string().min(1),
  version: z.number().int().min(1),
  partnerRef: z.string().min(1),

  platform: z.string().min(1).max(60),
  handle: z.string().min(1).max(120).nullable().default(null),
  displayName: z.string().min(1).max(200).nullable().default(null),
  profileUrl: z.string().min(1).max(500).nullable().default(null),
  // The strongest, most durable identity evidence a platform can offer -
  // preferred over handle/URL whenever present (see identity.ts).
  platformAccountId: z.string().min(1).max(200).nullable().default(null),

  // Computed ONCE at creation from whichever evidence was strongest then
  // (platformAccountId > profileUrl > handle) and NEVER recomputed on a
  // later edit - see identity.ts's own comment for why. This is what
  // concurrency-safe uniqueness is actually enforced against (via
  // partnerAccountIdentityClaims), not the raw handle/URL fields.
  normalizedIdentity: z.string().min(1).max(400),

  primary: z.boolean().default(false),
  status: partnerAccountStatusSchema,

  // Contextual current metadata only - never a source of truth for
  // Analytics, which will own its own real metrics pipeline later.
  followerSnapshot: z.object({ count: z.number().int().min(0), asOf: z.string().min(1) }).nullable().default(null),

  // Provenance only, when this account was created by Discovery
  // conversion - null for a directly-created account.
  originAssetDecision: assetDecisionKindSchema.nullable().default(null),
  originLeadRef: z.string().min(1).nullable().default(null),

  createdAt: z.string().min(1),
  createdByUserRef: z.string().min(1),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type PartnerAccountDoc = z.infer<typeof partnerAccountDocSchema>;
export type { AssetDecisionKind };

// --- Concurrency-safe normalized-identity claim (partnerAccountIdentityClaims/{sha256(normalizedIdentity)}) ---
// One document per claimed normalizedIdentity - its existence IS the
// uniqueness lock. Never queried by callers directly; always read/written
// inside the same transaction as the Partner Account create it guards
// (see partner-account-service.ts).
export const partnerAccountIdentityClaimDocSchema = z.object({
  normalizedIdentity: z.string().min(1).max(400),
  partnerAccountUid: z.string().min(1),
  partnerAccountRef: z.string().min(1),
  claimedAt: z.string().min(1),
});
export type PartnerAccountIdentityClaimDoc = z.infer<typeof partnerAccountIdentityClaimDocSchema>;

// --- Restricted financial identity (restrictedFinancialIdentities/{partnerUid}) ---
// The same trusted-server-only boundary as Discovery's restricted KYC:
// direct browser Firestore access denied, explicit sensitive-access class
// required (see partners-gate.ts), ordinary Partner DTOs/notes/history/
// export never contain these values, no masking-as-security.
export const partnerRestrictedIdentityEvidenceSchema = z.object({
  docType: z.enum(["pan", "aadhaar", "bank", "gst", "other"]),
  kind: z.enum(["link", "upload"]),
  url: z.string().min(1).max(1000),
  fileName: z.string().min(1).max(200).nullable(),
  addedAt: z.string().min(1),
  addedByUserRef: z.string().min(1),
});
export type PartnerRestrictedIdentityEvidence = z.infer<typeof partnerRestrictedIdentityEvidenceSchema>;

export const restrictedFinancialIdentityDocSchema = z.object({
  uid: z.string().min(1), // == partner uid, 1:1
  partnerRef: z.string().min(1),
  version: z.number().int().min(1),
  pan: z.object({ number: z.string().min(1).max(20) }).nullable().default(null),
  aadhaar: z.object({ number: z.string().min(1).max(40) }).nullable().default(null),
  bank: z
    .object({
      accountHolderName: z.string().min(1).max(200),
      accountNumber: z.string().min(1).max(40),
      ifsc: z.string().min(1).max(20),
      bankName: z.string().min(1).max(120),
      branchName: z.string().min(1).max(120),
    })
    .nullable()
    .default(null),
  gst: z.object({ applicable: z.boolean(), number: z.string().min(1).max(30).optional() }).nullable().default(null),
  evidence: z.array(partnerRestrictedIdentityEvidenceSchema).default([]),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type RestrictedFinancialIdentityDoc = z.infer<typeof restrictedFinancialIdentityDocSchema>;

// --- Append-only Partner event/audit history (partners/{uid}/events) ---
export const PARTNER_EVENT_KINDS = [
  "created",
  "edited",
  "owner_team_changed",
  "status_changed",
  "blacklisted",
  "archived",
  "restored",
  "account_created",
  "account_edited",
  "account_identity_changed",
  "account_status_changed",
  "primary_account_changed",
  "restricted_identity_saved",
] as const;
export const partnerEventKindSchema = z.enum(PARTNER_EVENT_KINDS);
export type PartnerEventKind = z.infer<typeof partnerEventKindSchema>;

export const partnerEventSchema = z.object({
  kind: partnerEventKindSchema,
  actorUserRef: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  requestId: z.string().min(1),
  createdAt: z.string().min(1),
});
export type PartnerEvent = z.infer<typeof partnerEventSchema>;

// --- Duplicate check (pre-create, advisory - never persisted onto the Partner) ---
export const PARTNER_DUPLICATE_MATCH_TYPES = ["email", "phone", "accountIdentity", "originLeadRef"] as const;
export const partnerDuplicateMatchTypeSchema = z.enum(PARTNER_DUPLICATE_MATCH_TYPES);
export type PartnerDuplicateMatchType = z.infer<typeof partnerDuplicateMatchTypeSchema>;

export const partnerDuplicateMatchSchema = z.object({
  type: partnerDuplicateMatchTypeSchema,
  ref: z.string().min(1), // opaque partnerRef the match was found on
  confidence: z.enum(["low", "medium", "high"]),
});
export type PartnerDuplicateMatch = z.infer<typeof partnerDuplicateMatchSchema>;

export const partnerDuplicateStatusSchema = z.enum(["unknown", "none", "possible", "confirmed"]);
export const partnerDuplicateCheckResultSchema = z.object({
  status: partnerDuplicateStatusSchema,
  matches: z.array(partnerDuplicateMatchSchema).max(10).default([]),
  checkedAt: z.string().min(1),
});
export type PartnerDuplicateCheckResult = z.infer<typeof partnerDuplicateCheckResultSchema>;

// --- Dependency check (governance preconditions) ------------------------
export const partnerDependencyStatusSchema = z.enum(["clear", "blocked", "unknown"]);
export type PartnerDependencyStatus = z.infer<typeof partnerDependencyStatusSchema>;
export type PartnerDependencyResult = { status: PartnerDependencyStatus; blockers: string[] };

// --- Result/error plumbing - same shape as Discovery's, own module ------
export type PartnersDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied" | "sensitive_denied";

export type ReadinessIssue = { code: string; message: string };

export type PartnersServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "conflict" | "not_ready" | "internal";

export type PartnersServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: PartnersServiceErrorCode; message: string; reason?: PartnersDenialReason; blockers?: ReadinessIssue[] };

export type PartnersErrorResult = Extract<PartnersServiceResult<unknown>, { ok: false }>;

export function partnersUnauthorizedResult(reason: PartnersDenialReason): PartnersErrorResult {
  return { ok: false, code: "unauthorized", message: `Partners access denied (${reason}).`, reason };
}

export function partnersInvalidInputResult(message: string): PartnersErrorResult {
  return { ok: false, code: "invalid_input", message };
}

export function partnersNotReadyResult(message: string, blockers: ReadinessIssue[]): PartnersErrorResult {
  return { ok: false, code: "not_ready", message, blockers };
}
