import type { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import {
  accessGrantDocSchema,
  scopeAssignmentDocSchema,
  sensitiveAccessGrantDocSchema,
  userDocSchema,
} from "./types";

export const COLLECTIONS = {
  users: "users",
  accessGrants: "accessGrants",
  scopeAssignments: "scopeAssignments",
  sensitiveAccessGrants: "sensitiveAccessGrants",
} as const;

// Fetches one document and strictly parses it. Returns null for "doesn't
// exist" AND for "exists but doesn't parse" alike - every caller in this
// module treats both the same way: fail closed, never distinguish a
// missing record from a corrupt one in a way that could be used to probe
// the system.
async function getParsedDoc<Schema extends z.ZodTypeAny>(
  collection: string,
  docId: string,
  schema: Schema,
): Promise<z.infer<Schema> | null> {
  const snapshot = await getAdminFirestore().collection(collection).doc(docId).get();
  if (!snapshot.exists) return null;

  const result = schema.safeParse(snapshot.data());
  if (!result.success) return null;
  return result.data;
}

export function getUserDoc(uid: string) {
  return getParsedDoc(COLLECTIONS.users, uid, userDocSchema);
}

export function getAccessGrantDoc(role: string) {
  return getParsedDoc(COLLECTIONS.accessGrants, role, accessGrantDocSchema);
}

export function getScopeAssignmentDoc(uid: string) {
  return getParsedDoc(COLLECTIONS.scopeAssignments, uid, scopeAssignmentDocSchema);
}

export function getSensitiveAccessGrantDoc(role: string) {
  return getParsedDoc(COLLECTIONS.sensitiveAccessGrants, role, sensitiveAccessGrantDocSchema);
}
