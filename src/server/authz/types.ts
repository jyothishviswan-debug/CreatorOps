import { z } from "zod";

import { ACTIONS } from "./actions";
import { FEATURES } from "./features";
import { ROLES } from "./roles";

// Every Firestore document that feeds an authorization decision is
// strictly parsed with zod. Anything that doesn't parse - a missing
// field, a wrong type, an unrecognized enum value - is treated as
// malformed and the caller fails closed. See CHECKS in capabilities.ts,
// scope.ts and sensitive.ts for where these are used.

export const roleSchema = z.enum(ROLES);

export const userDocSchema = z.object({
  uid: z.string().min(1),
  email: z.string().min(1),
  role: roleSchema,
  active: z.boolean(),
  displayName: z.string().min(1),
  // Step 5A: the opaque, unguessable handle browser-facing code uses to
  // reference this user - the real Firebase uid (this doc's own id) never
  // leaves the server. Assigned once at creation and never reused/rotated.
  userRef: z.string().min(1),
  // Optimistic concurrency for profile mutations (displayName/role/
  // active) - see src/server/administration/users-service.ts. Starts at 1
  // and increments by exactly 1 on every accepted update.
  version: z.number().int().min(1),
});
export type UserDoc = z.infer<typeof userDocSchema>;

const featureGrantSchema = z.object({
  view: z.boolean(),
  actions: z.partialRecord(z.enum(ACTIONS), z.boolean()).default({}),
});
export type FeatureGrant = z.infer<typeof featureGrantSchema>;

export const accessGrantDocSchema = z.object({
  role: roleSchema,
  features: z.partialRecord(z.enum(FEATURES), featureGrantSchema).default({}),
});
export type AccessGrantDoc = z.infer<typeof accessGrantDocSchema>;

// Step 5B.1: per-user tri-state feature/action overrides on top of the
// role baseline above. `view` is optional (not required, unlike
// featureGrantSchema's) because a feature entry may only touch its
// actions, or vice versa - a KEY ABSENT from `actions` (via
// partialRecord) means "no override for that action", not "denied".
// Tri-state precedence: key absent = inherit role baseline; `true` =
// explicit allow; `false` = explicit deny. This is deliberately the same
// shape family as featureGrantSchema/accessGrantDocSchema so the two can
// be resolved by one shared precedence function (see capabilities.ts).
const featureOverrideSchema = z.object({
  view: z.boolean().optional(),
  actions: z.partialRecord(z.enum(ACTIONS), z.boolean()).default({}),
});
export type FeatureOverride = z.infer<typeof featureOverrideSchema>;

export const userAccessOverrideDocSchema = z.object({
  uid: z.string().min(1),
  features: z.partialRecord(z.enum(FEATURES), featureOverrideSchema).default({}),
  // Optimistic concurrency - same convention as userDocSchema: starts at
  // 1 on first write, increments by exactly 1 on every accepted mutation.
  version: z.number().int().min(1),
});
export type UserAccessOverrideDoc = z.infer<typeof userAccessOverrideDocSchema>;

// Step 5B.1A: a user's override document has THREE distinct states, not
// two. "absent" (no doc at all) genuinely means "no explicit overrides -
// inherit the role baseline", exactly as before. "invalid" (a doc exists
// but fails schema validation) must NOT be collapsed into the same
// behavior - silently treating corrupt override data as "no overrides"
// is not fail-closed, since if the role baseline already allows a
// module/action, ignoring a malformed override would accidentally
// PRESERVE that access instead of protecting it. So "invalid" is its own
// state: every caller that resolves access from this must deny outright
// until the document is corrected, never fall back to the role baseline.
// See resolveFeatureAccess/resolveActionAccess in capabilities.ts, the
// only place this distinction is actually interpreted.
export type OverrideLookup = { status: "absent" } | { status: "valid"; doc: UserAccessOverrideDoc } | { status: "invalid" };

// Step 4C's canonical, multi-dimensional Record Scope model. Each grant is
// its own flat document in the scopeAssignments collection (not nested
// under the user, and not one array-valued doc per user) so a single
// grant can be created/edited/deleted/audited independently - what future
// Administration CRUD needs - and so a bounded, indexed `where("uid",
// "==", uid)` query is all any caller ever needs to load one actor's
// grants. GLOBAL and SELF carry no discriminator of their own; every
// other type's discriminator field is what actually gets matched against
// a resource (see scope.ts). grantedAt/grantedBy exist for auditing only
// and are never used in an access decision.
export const scopeGrantTypeSchema = z.enum([
  "SELF",
  "GLOBAL",
  "REGION",
  "TEAM",
  "PARTNER",
  "CAMPAIGN",
  "EXPLICIT_RECORD",
  "ANALYTICS_DATASET",
  "ANALYTICS_ACCOUNT",
]);
export type ScopeGrantType = z.infer<typeof scopeGrantTypeSchema>;

const scopeGrantAuditFields = {
  uid: z.string().min(1),
  grantedAt: z.string().min(1),
  grantedBy: z.string().min(1),
};

export const scopeGrantSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SELF"), ...scopeGrantAuditFields }),
  z.object({ type: z.literal("GLOBAL"), ...scopeGrantAuditFields }),
  z.object({ type: z.literal("REGION"), region: z.string().min(1), ...scopeGrantAuditFields }),
  z.object({ type: z.literal("TEAM"), teamId: z.string().min(1), ...scopeGrantAuditFields }),
  z.object({ type: z.literal("PARTNER"), partnerId: z.string().min(1), ...scopeGrantAuditFields }),
  z.object({ type: z.literal("CAMPAIGN"), campaignId: z.string().min(1), ...scopeGrantAuditFields }),
  z.object({
    type: z.literal("EXPLICIT_RECORD"),
    resourceType: z.string().min(1),
    resourceId: z.string().min(1),
    ...scopeGrantAuditFields,
  }),
  z.object({ type: z.literal("ANALYTICS_DATASET"), datasetId: z.string().min(1), ...scopeGrantAuditFields }),
  z.object({ type: z.literal("ANALYTICS_ACCOUNT"), accountId: z.string().min(1), ...scopeGrantAuditFields }),
]);
export type ScopeGrant = z.infer<typeof scopeGrantSchema>;

// A plain Omit<ScopeGrant, ...> would collapse this discriminated union
// down to just the shared `type` field - Omit/Pick only see the
// intersection of a union's keys, not each member's own. Distributing the
// Omit over each member first is what actually keeps region/teamId/etc.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
// The same shape minus the audit fields - what callers building a grant
// (seeding, future Administration CRUD) supply; grantDocId/seed code fills
// in uid/grantedAt/grantedBy.
export type ScopeGrantInput = DistributiveOmit<ScopeGrant, "uid" | "grantedAt" | "grantedBy">;

export const sensitiveAccessGrantDocSchema = z.object({
  role: roleSchema,
  categories: z.array(z.string().min(1)).default([]),
});
export type SensitiveAccessGrantDoc = z.infer<typeof sensitiveAccessGrantDocSchema>;

// The server-resolved identity of the current request. Built once per
// request from the verified session + the users/{uid} document - never
// from anything the client asserts about itself.
export type ActorContext = {
  uid: string;
  email: string;
  role: (typeof ROLES)[number];
  displayName: string;
  // The actor's own opaque handle - carried through so Administration
  // audit events can record "who did this" without ever writing a raw
  // Firebase uid into anything that might be exposed to a browser later.
  userRef: string;
};

// Step 5A: a server-written, append-only record of every access-changing
// Administration mutation. Never exposed to direct client Firestore
// access (see firestore.rules); read only through the audit API, which
// converts this to a safe DTO (opaque userRef only, never a raw uid).
// `before`/`after` are free-form but must only ever contain non-secret
// metadata - callers are responsible for never putting a password, token,
// or other restricted value in them (see audit.ts's redaction helper).
export const auditOperationSchema = z.enum([
  "user.create",
  "user.update",
  "user.role_change",
  "user.activate",
  "user.deactivate",
  "scope_grant.add",
  "scope_grant.remove",
  "sensitive_grant.add",
  "sensitive_grant.remove",
  "access_override.set",
]);
export type AuditOperation = z.infer<typeof auditOperationSchema>;

const safeMetadataSchema = z.record(z.string(), z.unknown()).nullable();

export const auditEventSchema = z.object({
  operation: auditOperationSchema,
  actorUid: z.string().min(1),
  actorUserRef: z.string().min(1),
  actorEmail: z.string().min(1),
  targetUid: z.string().min(1).optional(),
  targetUserRef: z.string().min(1).optional(),
  targetEmail: z.string().min(1).optional(),
  targetRole: roleSchema.optional(),
  before: safeMetadataSchema,
  after: safeMetadataSchema,
  requestId: z.string().min(1),
  createdAt: z.string().min(1),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;
