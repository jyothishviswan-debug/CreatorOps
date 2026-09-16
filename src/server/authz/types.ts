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
};
