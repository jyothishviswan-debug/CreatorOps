import type { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { Role } from "./roles";
import { accessGrantDocSchema, scopeGrantSchema, sensitiveAccessGrantDocSchema, userAccessOverrideDocSchema, userDocSchema, type ScopeGrant, type UserAccessOverrideDoc, type UserDoc } from "./types";

export const COLLECTIONS = {
  users: "users",
  accessGrants: "accessGrants",
  scopeAssignments: "scopeAssignments",
  sensitiveAccessGrants: "sensitiveAccessGrants",
  userAccessOverrides: "userAccessOverrides",
  auditEvents: "auditEvents",
} as const;

// Bounded pagination default/ceiling - "no whole-collection client fetch"
// applies even to a caller that asks for an absurd page size.
export const MAX_LIST_PAGE_SIZE = 100;
export const DEFAULT_LIST_PAGE_SIZE = 20;

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

// A missing or malformed override document is not an error - it means
// "no explicit overrides for this user", and every caller that resolves
// access treats that identically to an empty override map (fail closed:
// a corrupt override document can never grant more than the role
// baseline already would).
export function getUserAccessOverrideDoc(uid: string): Promise<UserAccessOverrideDoc | null> {
  return getParsedDoc(COLLECTIONS.userAccessOverrides, uid, userAccessOverrideDocSchema);
}

// Resolves a user by their opaque, browser-facing userRef instead of the
// real Firebase uid. A tampered or made-up token simply matches no
// document - there is nothing to "almost match" against, since userRef
// is random and carries no embedded, decodable information about the uid
// it points to (see src/server/administration/user-ref.ts).
export async function getUserDocByRef(userRef: string): Promise<UserDoc | null> {
  const snapshot = await getAdminFirestore().collection(COLLECTIONS.users).where("userRef", "==", userRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = userDocSchema.safeParse(snapshot.docs[0]!.data());
  if (!result.success) return null;
  return result.data;
}

export type UserListCursor = { email: string; userRef: string };

export type ListUsersPage = {
  users: UserDoc[];
  nextCursor: UserListCursor | null;
};

// Deterministically ordered (email, then userRef as a tiebreak), bounded
// cursor pagination - never a whole-collection fetch. The cursor is built
// entirely from fields already safe to hand back to the client (they're
// already in the DTO), so there's no need to expose a Firestore document
// reference or the raw uid to encode "where to resume".
export async function listUserDocs(options: {
  limit: number;
  cursor?: UserListCursor;
  role?: Role;
  active?: boolean;
  // A bounded, indexed email-prefix range query (not a client-side
  // substring filter over a preloaded page) - the same "search a user"
  // idiom a real Administration console needs, without ever fetching an
  // unbounded set to filter locally. Case-sensitive on the stored email
  // (emails are seeded/created lowercase); callers normalize input.
  emailPrefix?: string;
}): Promise<ListUsersPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_LIST_PAGE_SIZE));

  let query = getAdminFirestore().collection(COLLECTIONS.users).orderBy("email").orderBy("userRef").limit(pageSize + 1);
  if (options.role) query = query.where("role", "==", options.role);
  if (options.active !== undefined) query = query.where("active", "==", options.active);
  if (options.emailPrefix) query = query.where("email", ">=", options.emailPrefix).where("email", "<", `${options.emailPrefix}`);
  if (options.cursor) query = query.startAfter(options.cursor.email, options.cursor.userRef);

  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const hasMore = snapshot.docs.length > pageSize;

  const users: UserDoc[] = [];
  for (const doc of pageDocs) {
    const result = userDocSchema.safeParse(doc.data());
    if (result.success) users.push(result.data);
  }

  const last = users[users.length - 1];
  const nextCursor = hasMore && last ? { email: last.email, userRef: last.userRef } : null;

  return { users, nextCursor };
}
