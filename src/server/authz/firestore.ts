import type { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import { accessGrantDocSchema, scopeGrantSchema, sensitiveAccessGrantDocSchema, userDocSchema, type ScopeGrant } from "./types";

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

// One flat scopeAssignments document per grant (see types.ts), so an
// actor's grants are a bounded, indexed `where("uid", "==", uid)` query -
// never a full collection scan - capped defensively at 500 so a runaway
// number of grants for one user can never turn into an unbounded read.
// A grant document that fails to parse (malformed or an unrecognized
// `type`) is simply dropped from the result, not treated as poisoning
// every other valid grant the actor has - each grant fails closed on its
// own.
export async function getActorScopeGrants(uid: string): Promise<ScopeGrant[]> {
  const snapshot = await getAdminFirestore().collection(COLLECTIONS.scopeAssignments).where("uid", "==", uid).limit(500).get();

  const grants: ScopeGrant[] = [];
  for (const doc of snapshot.docs) {
    const result = scopeGrantSchema.safeParse(doc.data());
    if (result.success) grants.push(result.data);
  }
  return grants;
}

export function getSensitiveAccessGrantDoc(role: string) {
  return getParsedDoc(COLLECTIONS.sensitiveAccessGrants, role, sensitiveAccessGrantDocSchema);
}
