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

export const scopeAssignmentDocSchema = z.object({
  uid: z.string().min(1),
  regions: z.array(z.string().min(1)).min(1),
});
export type ScopeAssignmentDoc = z.infer<typeof scopeAssignmentDocSchema>;

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
