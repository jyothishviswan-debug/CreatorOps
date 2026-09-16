// Step 5B.1: generalizes Step 5A's "last active Super Admin" protection
// into "the last usable Administration manager", based on EFFECTIVE
// access (role baseline + user override + scope), not a role label. A
// mutation of any kind - role change, deactivation, a feature/action
// override, or removing GLOBAL scope - must never leave zero active
// users who can still fully administer users/access.
import type { Transaction } from "firebase-admin/firestore";

import { resolveActionAccess, resolveFeatureAccess } from "./capabilities";
import { COLLECTIONS, listUserDocs } from "./firestore";
import { getAdminFirestore } from "@/server/firebase/admin";
import type { Role } from "./roles";
import { accessGrantDocSchema, scopeGrantSchema, userAccessOverrideDocSchema, type AccessGrantDoc, type OverrideLookup } from "./types";

// The full set of capabilities that together make someone able to
// administer users/access - matches every action requireAdministrationAccess
// ever gates an Administration mutation on. "Final usable Administration
// manager" means at least one active user must resolve to ALL of these,
// not just the general "administration" feature.
const ADMIN_MANAGER_ACTIONS = ["manage_users", "manage_overrides", "manage_scope", "manage_sensitive", "view_audit"] as const;

export function resolvesToAdminManagerCapability(params: {
  active: boolean;
  accessGrant: AccessGrantDoc | null;
  override: OverrideLookup;
  hasGlobalScope: boolean;
}): boolean {
  if (!params.active) return false;
  if (!resolveFeatureAccess(params.accessGrant, params.override, "administration")) return false;
  if (!params.hasGlobalScope) return false;
  for (const action of ADMIN_MANAGER_ACTIONS) {
    if (!resolveActionAccess(params.accessGrant, params.override, "administration", action)) return false;
  }
  return true;
}

export type Reader = {
  doc: (path: string) => Promise<FirebaseFirestore.DocumentSnapshot>;
};

export function readerFor(tx?: Transaction): Reader {
  const db = getAdminFirestore();
  return {
    // Split "collection/docId" and go through collection().doc(), same
    // chain every other read in this codebase uses (and the only shape
    // fake-firestore test doubles implement) - rather than the admin
    // SDK's own single-string db.doc(path) convenience method.
    doc: (path: string) => {
      const separatorIndex = path.indexOf("/");
      const collectionId = path.slice(0, separatorIndex);
      const docId = path.slice(separatorIndex + 1);
      const ref = db.collection(collectionId).doc(docId);
      return tx ? tx.get(ref) : ref.get();
    },
  };
}

export async function loadAccessGrant(reader: Reader, role: Role): Promise<AccessGrantDoc | null> {
  const snap = await reader.doc(`${COLLECTIONS.accessGrants}/${role}`);
  if (!snap.exists) return null;
  const result = accessGrantDocSchema.safeParse(snap.data());
  return result.success ? result.data : null;
}

export async function loadOverrideLookup(reader: Reader, uid: string): Promise<OverrideLookup> {
  const snap = await reader.doc(`${COLLECTIONS.userAccessOverrides}/${uid}`);
  if (!snap.exists) return { status: "absent" };
  const result = userAccessOverrideDocSchema.safeParse(snap.data());
  if (!result.success) return { status: "invalid" };
  return { status: "valid", doc: result.data };
}

// GLOBAL scope grants have a deterministic doc id (see scope.ts's
// scopeGrantDocId), so "does this uid have GLOBAL scope" is a single
// direct document read, not a query - safe to do inside a transaction
// and cheap to repeat per candidate.
export async function loadHasGlobalScope(reader: Reader, uid: string): Promise<boolean> {
  const snap = await reader.doc(`${COLLECTIONS.scopeAssignments}/${uid}__GLOBAL`);
  if (!snap.exists) return false;
  const result = scopeGrantSchema.safeParse(snap.data());
  return result.success && result.data.type === "GLOBAL";
}

export async function resolveCandidateCapability(reader: Reader, candidate: { uid: string; role: Role; active: boolean }): Promise<boolean> {
  const [accessGrant, override, hasGlobalScope] = await Promise.all([
    loadAccessGrant(reader, candidate.role),
    loadOverrideLookup(reader, candidate.uid),
    loadHasGlobalScope(reader, candidate.uid),
  ]);
  return resolvesToAdminManagerCapability({ active: candidate.active, accessGrant, override, hasGlobalScope });
}

// Bounded scan (same page-size ceiling as every other Administration
// list read) over active users, excluding one uid, stopping as soon as
// a single other capable manager is found - this only ever needs to
// answer "is there at least one", never "how many".
export async function hasAnotherActiveAdminManager(excludingUid: string, tx?: Transaction): Promise<boolean> {
  const reader = readerFor(tx);
  let cursor: { email: string; userRef: string } | undefined;

  for (let page = 0; page < 5; page += 1) {
    const result = await listUserDocs({ limit: 100, active: true, cursor });
    for (const candidate of result.users) {
      if (candidate.uid === excludingUid) continue;
      if (await resolveCandidateCapability(reader, candidate)) return true;
    }
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return false;
}
