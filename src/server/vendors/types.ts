import { z } from "zod";

// Step 8A: the canonical Vendor domain. Vendor = an agency, manager,
// representative, payee, or other business entity associated with one or
// more Partners - never a subtype of Partner, never the old polymorphic
// Partner model. The relationship between a Vendor and the Partner(s) it
// works with is a first-class M:N link (vendorPartnerLinks), never an
// embedded array on either side and never a field on Partner itself.
//
// Discovery/Partners precedent: this file follows the exact same
// contract shape as src/server/partners/types.ts (lifecycle, result
// plumbing, restricted-identity boundary) - deliberately, so the two
// domains stay recognizably parallel without actually sharing state.

// --- Vendor lifecycle ---------------------------------------------------
// ACTIVE <-> INACTIVE is a freely reversible operational toggle (its own
// transition_vendor_lifecycle action). ARCHIVED is a controlled
// governance state, only reached through archiveVendor (reason + version
// precondition + dependency check + immutable event), restored only
// through restoreVendor (history-preserving, returns to previousStatus).
// No BLACKLISTED state - Step 8A's prompt explicitly says not to invent
// one without a newer accepted authority requiring it; none was found.
export const VENDOR_STATUSES = ["ACTIVE", "INACTIVE", "ARCHIVED"] as const;
export const vendorStatusSchema = z.enum(VENDOR_STATUSES);
export type VendorStatus = z.infer<typeof vendorStatusSchema>;

export const VENDOR_GOVERNANCE_STATUSES = ["ARCHIVED"] as const satisfies readonly VendorStatus[];

// A focused catalog, not a speculative one - Step 8A's own suggested set.
// No newer accepted authority (docs/product, golden master, existing
// server code) defines a different exact list - the only prior art found
// was the illustrative Vendors fixture UI's simpler 4-category sample
// data (Agency/Manager/Payee/Other), which is not a binding domain
// contract, so this uses the prompt's own catalog verbatim.
export const VENDOR_TYPES = ["AGENCY", "MANAGEMENT_COMPANY", "MANAGER_REPRESENTATIVE", "PAYEE_BUSINESS", "OTHER"] as const;
export const vendorTypeSchema = z.enum(VENDOR_TYPES);
export type VendorType = z.infer<typeof vendorTypeSchema>;

// --- Vendor document (vendors/{uid}) ------------------------------------
export const vendorDocSchema = z.object({
  uid: z.string().min(1),
  vendorRef: z.string().min(1),
  version: z.number().int().min(1),

  displayName: z.string().min(1).max(200),
  displayNameLower: z.string().min(1).max(200),
  legalName: z.string().min(1).max(200).nullable().default(null),
  vendorType: vendorTypeSchema,

  status: vendorStatusSchema,
  previousStatus: vendorStatusSchema.nullable().default(null),
  statusReason: z.string().min(1).max(1000).nullable().default(null),

  // Safe ordinary contact/business metadata only - never restricted tax/
  // bank/KYC values (see @/server/shared/restricted-financial-identity.ts).
  email: z.string().min(1).max(300).nullable().default(null),
  phone: z.string().min(1).max(40).nullable().default(null),
  // Optional ordinary business references/links (e.g. a public website,
  // a registration number label) - explicitly NOT restricted identifiers;
  // those live only in the restricted subject document.
  businessReferences: z.array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(300) })).max(20).default([]),

  regionIds: z.array(z.string().min(1)).max(50).default([]),
  ownerUid: z.string().min(1).nullable().default(null),
  teamIds: z.array(z.string().min(1)).max(50).default([]),

  createdAt: z.string().min(1),
  createdByUserRef: z.string().min(1),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type VendorDoc = z.infer<typeof vendorDocSchema>;

// --- Vendor <-> Partner relationship link (vendorPartnerLinks/{uid}) ----
// A Vendor may link to many Partners at once (one agency can represent
// many creators) - that side of the M:N stays wide open. The other
// direction is policy-constrained: a Partner may have at most ONE
// ACTIVE Vendor relationship at a time (company policy - one agency/
// company handles a Partner's operations and payments in full; no
// splitting a Partner's representation across simultaneous Vendors).
// Enforced server-side in vendor-partner-link-service.ts's
// createVendorPartnerLink, not by a Firestore-level constraint. A
// Partner with zero active links is simply handled directly, with no
// Vendor intermediary. Never hard-deleted; ending a relationship sets
// status=ENDED and effectiveTo, the row itself stays - which is also
// how a Partner becomes free for a new active Vendor link.
export const RELATIONSHIP_TYPES = ["REPRESENTATION", "MANAGEMENT", "AGENCY", "PAYEE", "OTHER"] as const;
export const relationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);
export type RelationshipType = z.infer<typeof relationshipTypeSchema>;

export const vendorPartnerLinkStatusSchema = z.enum(["ACTIVE", "ENDED"]);
export type VendorPartnerLinkStatus = z.infer<typeof vendorPartnerLinkStatusSchema>;

export const vendorPartnerLinkDocSchema = z.object({
  uid: z.string().min(1),
  vendorPartnerLinkRef: z.string().min(1),
  version: z.number().int().min(1),

  vendorRef: z.string().min(1),
  partnerRef: z.string().min(1),
  // The one Vendor's role for this Partner - since a Partner has at most
  // one ACTIVE Vendor, this single field now stands for that Vendor's
  // whole relationship (there is no separate payee flag; the Partner's
  // one active Vendor is always the one handling payments too).
  relationshipType: relationshipTypeSchema,

  effectiveFrom: z.string().min(1),
  effectiveTo: z.string().min(1).nullable().default(null),
  status: vendorPartnerLinkStatusSchema,

  createdAt: z.string().min(1),
  createdByUserRef: z.string().min(1),
  updatedAt: z.string().min(1),
  updatedByUserRef: z.string().min(1),
});
export type VendorPartnerLinkDoc = z.infer<typeof vendorPartnerLinkDocSchema>;

// --- Restricted Vendor financial identity ---------------------------------
// Step 8A.1: moved to the one canonical, cross-domain
// restrictedFinancialIdentities collection - see
// @/server/shared/restricted-financial-identity.ts for the schema,
// collection accessor, and subjectType-prefixed doc-id scheme (subject
// discriminator "VENDOR", never colliding with a Partner subject). The
// trusted-server boundary itself is unchanged: still gated by
// "vendor_payment_details" (never Partners' own "payment_details" - see
// sensitive-categories.ts's own comment), still a dedicated Vendor-
// specific service (restricted-identity-service.ts) - only the
// underlying persistence family is shared now, not duplicated.

// --- Append-only Vendor event/audit history (vendors/{uid}/events) -----
// A single combined stream per Vendor - covers both Vendor-level changes
// and every relationship (link) change this Vendor was party to, same
// "one event log, not a second per sub-entity" idiom as Partners' own
// account-identity-changed events living in the Partner's own stream.
export const VENDOR_EVENT_KINDS = [
  "created",
  "edited",
  "owner_team_changed",
  "status_changed",
  "archived",
  "restored",
  "link_created",
  "link_edited",
  "link_ended",
  "link_restored",
  "restricted_identity_saved",
] as const;
export const vendorEventKindSchema = z.enum(VENDOR_EVENT_KINDS);
export type VendorEventKind = z.infer<typeof vendorEventKindSchema>;

export const vendorEventSchema = z.object({
  kind: vendorEventKindSchema,
  actorUserRef: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  requestId: z.string().min(1),
  createdAt: z.string().min(1),
});
export type VendorEvent = z.infer<typeof vendorEventSchema>;

// --- Duplicate check (pre-create, advisory - never persisted) ----------
export const VENDOR_DUPLICATE_MATCH_TYPES = ["displayName", "email", "phone"] as const;
export const vendorDuplicateMatchTypeSchema = z.enum(VENDOR_DUPLICATE_MATCH_TYPES);
export type VendorDuplicateMatchType = z.infer<typeof vendorDuplicateMatchTypeSchema>;

export const vendorDuplicateMatchSchema = z.object({
  type: vendorDuplicateMatchTypeSchema,
  ref: z.string().min(1), // opaque vendorRef the match was found on
  confidence: z.enum(["low", "medium", "high"]),
});
export type VendorDuplicateMatch = z.infer<typeof vendorDuplicateMatchSchema>;

export const vendorDuplicateStatusSchema = z.enum(["unknown", "none", "possible", "confirmed"]);
export const vendorDuplicateCheckResultSchema = z.object({
  status: vendorDuplicateStatusSchema,
  matches: z.array(vendorDuplicateMatchSchema).max(10).default([]),
  checkedAt: z.string().min(1),
});
export type VendorDuplicateCheckResult = z.infer<typeof vendorDuplicateCheckResultSchema>;

// --- Dependency check (governance preconditions) ------------------------
export const vendorDependencyStatusSchema = z.enum(["clear", "blocked", "unknown"]);
export type VendorDependencyStatus = z.infer<typeof vendorDependencyStatusSchema>;
export type VendorDependencyResult = { status: VendorDependencyStatus; blockers: string[] };

// --- Result/error plumbing - same shape as Partners', own module -------
export type VendorsDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied" | "sensitive_denied";

export type ReadinessIssue = { code: string; message: string };

export type VendorsServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "conflict" | "not_ready" | "internal";

export type VendorsServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: VendorsServiceErrorCode; message: string; reason?: VendorsDenialReason; blockers?: ReadinessIssue[] };

export type VendorsErrorResult = Extract<VendorsServiceResult<unknown>, { ok: false }>;

export function vendorsUnauthorizedResult(reason: VendorsDenialReason): VendorsErrorResult {
  return { ok: false, code: "unauthorized", message: `Vendors access denied (${reason}).`, reason };
}

export function vendorsInvalidInputResult(message: string): VendorsErrorResult {
  return { ok: false, code: "invalid_input", message };
}

export function vendorsNotReadyResult(message: string, blockers: ReadinessIssue[]): VendorsErrorResult {
  return { ok: false, code: "not_ready", message, blockers };
}
