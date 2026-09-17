import { FieldPath, Filter } from "firebase-admin/firestore";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { ScopeGrant } from "@/server/authz/types";
import {
  partnerAccountDocSchema,
  partnerAccountIdentityClaimDocSchema,
  partnerDocSchema,
  type PartnerAccountDoc,
  type PartnerAccountIdentityClaimDoc,
  type PartnerDoc,
} from "./types";

// Step 8A.1: restrictedFinancialIdentities moved to the one canonical,
// cross-domain collection - see
// @/server/shared/restricted-financial-identity.ts. No longer listed
// here; this module never owns it.
export const PARTNERS_COLLECTIONS = {
  partners: "partners",
  partnerEvents: "events", // subcollection name under partners/{uid}
  partnerAccounts: "partnerAccounts",
  partnerAccountIdentityClaims: "partnerAccountIdentityClaims",
} as const;

export const MAX_PARTNER_PAGE_SIZE = 100;
export const DEFAULT_PARTNER_PAGE_SIZE = 20;
export const MAX_PARTNER_ACCOUNT_PAGE_SIZE = 100;

// Firestore's `in` operator caps at 30 values per query - same bounded
// discipline as Discovery's firestore.ts.
const MAX_SCOPE_IN_VALUES = 30;

export function partnersCollection() {
  return getAdminFirestore().collection(PARTNERS_COLLECTIONS.partners);
}

export function partnerEventsCollection(partnerUid: string) {
  return partnersCollection().doc(partnerUid).collection(PARTNERS_COLLECTIONS.partnerEvents);
}

export function partnerAccountsCollection() {
  return getAdminFirestore().collection(PARTNERS_COLLECTIONS.partnerAccounts);
}

export function partnerAccountIdentityClaimsCollection() {
  return getAdminFirestore().collection(PARTNERS_COLLECTIONS.partnerAccountIdentityClaims);
}

export async function getPartnerDocByUid(uid: string): Promise<PartnerDoc | null> {
  const snapshot = await partnersCollection().doc(uid).get();
  if (!snapshot.exists) return null;
  const result = partnerDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Resolves a Partner by its opaque, browser-facing partnerRef instead of
// the internal Firestore doc id - same idiom as getLeadDocByRef. A
// tampered or made-up token simply matches no document (never leaks
// whether a differently-scoped Partner exists).
export async function getPartnerDocByRef(partnerRef: string): Promise<PartnerDoc | null> {
  const snapshot = await partnersCollection().where("partnerRef", "==", partnerRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = partnerDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export async function getPartnerAccountDocByUid(uid: string): Promise<PartnerAccountDoc | null> {
  const snapshot = await partnerAccountsCollection().doc(uid).get();
  if (!snapshot.exists) return null;
  const result = partnerAccountDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getPartnerAccountDocByRef(partnerAccountRef: string): Promise<PartnerAccountDoc | null> {
  const snapshot = await partnerAccountsCollection().where("partnerAccountRef", "==", partnerAccountRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = partnerAccountDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export async function getPartnerAccountIdentityClaim(claimId: string): Promise<PartnerAccountIdentityClaimDoc | null> {
  const snapshot = await partnerAccountIdentityClaimsCollection().doc(claimId).get();
  if (!snapshot.exists) return null;
  const result = partnerAccountIdentityClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export type PartnerMutationResult = { kind: "ok"; doc: PartnerDoc } | { kind: "stale" } | { kind: "not_found" };

// Shared transactional "read current, verify optimistic version, apply a
// pure patch, write" primitive - same discipline as Discovery's
// runLeadMutation. Used by every ordinary Partner field mutation;
// lifecycle/governance transitions (which need extra preconditions) run
// their own transactions instead (see partner-lifecycle-service.ts).
export async function runPartnerMutation(partnerUid: string, expectedVersion: number, mutate: (current: PartnerDoc) => PartnerDoc): Promise<PartnerMutationResult> {
  const db = getAdminFirestore();
  const docRef = partnersCollection().doc(partnerUid);

  return db.runTransaction<PartnerMutationResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsed = partnerDocSchema.safeParse(snap.data());
    if (!parsed.success) return { kind: "not_found" };
    const current = parsed.data;

    if (current.version !== expectedVersion) return { kind: "stale" };

    const next = { ...mutate(current), version: current.version + 1 };
    tx.set(docRef, next);
    return { kind: "ok", doc: next };
  });
}

export type PartnerAccountMutationResult = { kind: "ok"; doc: PartnerAccountDoc } | { kind: "stale" } | { kind: "not_found" };

export async function runPartnerAccountMutation(
  accountUid: string,
  expectedVersion: number,
  mutate: (current: PartnerAccountDoc) => PartnerAccountDoc,
): Promise<PartnerAccountMutationResult> {
  const db = getAdminFirestore();
  const docRef = partnerAccountsCollection().doc(accountUid);

  return db.runTransaction<PartnerAccountMutationResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsed = partnerAccountDocSchema.safeParse(snap.data());
    if (!parsed.success) return { kind: "not_found" };
    const current = parsed.data;

    if (current.version !== expectedVersion) return { kind: "stale" };

    const next = { ...mutate(current), version: current.version + 1 };
    tx.set(docRef, next);
    return { kind: "ok", doc: next };
  });
}

// Opaque to callers - whichever field the active query mode is actually
// ordered by (createdAt / displayNameLower). Echoed back unchanged.
export type PartnerListCursor = { orderValue: string; uid: string };
export type ListPartnersPage = { partners: PartnerDoc[]; nextCursor: PartnerListCursor | null };

// Builds the OR-combined scope filter for a non-GLOBAL actor's grants -
// same construction as Discovery's buildLeadScopeFilter, adapted to the
// Partner scope dimensions (SELF -> ownerUid ==, REGION -> regionIds
// array-contains-any, TEAM -> teamIds array-contains-any, PARTNER ->
// document id in [...] (a PARTNER-type grant's partnerId names the
// Partner's own uid), EXPLICIT_RECORD(partner) -> document id in [...]).
// Returns null when the actor holds none of these - the caller must
// treat that as "return an empty page" (no missing-scope => global
// fallback).
function buildPartnerScopeFilter(actorUid: string, grants: ScopeGrant[]): Filter | null {
  const branches: Filter[] = [];

  if (grants.some((g) => g.type === "SELF")) {
    branches.push(Filter.where("ownerUid", "==", actorUid));
  }

  const regions = [...new Set(grants.filter((g): g is Extract<ScopeGrant, { type: "REGION" }> => g.type === "REGION").map((g) => g.region))].slice(0, MAX_SCOPE_IN_VALUES);
  if (regions.length > 0) branches.push(Filter.where("regionIds", "array-contains-any", regions));

  const teamIds = [...new Set(grants.filter((g): g is Extract<ScopeGrant, { type: "TEAM" }> => g.type === "TEAM").map((g) => g.teamId))].slice(0, MAX_SCOPE_IN_VALUES);
  if (teamIds.length > 0) branches.push(Filter.where("teamIds", "array-contains-any", teamIds));

  const explicitPartnerUids = [
    ...new Set([
      ...grants.filter((g): g is Extract<ScopeGrant, { type: "PARTNER" }> => g.type === "PARTNER").map((g) => g.partnerId),
      ...grants
        .filter((g): g is Extract<ScopeGrant, { type: "EXPLICIT_RECORD" }> => g.type === "EXPLICIT_RECORD" && g.resourceType === "partner")
        .map((g) => g.resourceId),
    ]),
  ].slice(0, MAX_SCOPE_IN_VALUES);
  if (explicitPartnerUids.length > 0) branches.push(Filter.where(FieldPath.documentId(), "in", explicitPartnerUids));

  if (branches.length === 0) return null;
  return branches.length === 1 ? branches[0]! : Filter.or(...branches);
}

// Bounded cursor pagination, scope-constrained BEFORE retrieval - never a
// browser or server fetch-all followed by in-memory filtering. Mirrors
// Discovery's listLeadDocs exactly, and the same grid discipline as
// Vendors' own listVendorDocs (see firestore.indexes.json's
// "partners" entries, certified Step 8A.1): one composite index per
// {SELF/REGION/TEAM scope branch} x {createdAt-desc order, displayName
// search order}, one status+branch+createdAt layer, and one standalone
// {filter}+createdAt entry each for tier/targetAudience/
// pendingPartnerAccountSetup - never every possible filter combination
// (the EXPLICIT_RECORD/PARTNER scope branch's documentId()-in and a
// stacked region+extra-filter combo stay intentionally unindexed, same
// accepted gap as Discovery's own region+lifecycle-adjacent combos - a
// real Firestore project surfaces those as a clear "create this index"
// error, never silently wrong results). The local emulator does not
// enforce composite indexes at all.
export async function listPartnerDocs(options: {
  limit: number;
  cursor?: PartnerListCursor;
  actorUid: string;
  grants: ScopeGrant[];
  hasGlobal: boolean;
  status?: string;
  displayNamePrefix?: string;
  region?: string;
  ownerUid?: string;
  tier?: string;
  targetAudience?: string;
  pendingPartnerAccountSetup?: boolean;
}): Promise<ListPartnersPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_PARTNER_PAGE_SIZE));

  let scopeFilter: Filter | null = null;
  if (!options.hasGlobal) {
    scopeFilter = buildPartnerScopeFilter(options.actorUid, options.grants);
    if (!scopeFilter) return { partners: [], nextCursor: null };
  }

  const filters: Filter[] = [];
  if (scopeFilter) filters.push(scopeFilter);
  if (options.status) filters.push(Filter.where("status", "==", options.status));
  if (options.region) filters.push(Filter.where("regionIds", "array-contains", options.region));
  if (options.ownerUid) filters.push(Filter.where("ownerUid", "==", options.ownerUid));
  if (options.tier) filters.push(Filter.where("tier", "==", options.tier));
  if (options.targetAudience) filters.push(Filter.where("targetAudience", "==", options.targetAudience));
  if (options.pendingPartnerAccountSetup) filters.push(Filter.where("pendingPartnerAccountSetup", "==", true));

  let orderField = "createdAt";
  let orderDirection: FirebaseFirestore.OrderByDirection = "desc";
  if (options.displayNamePrefix) {
    orderField = "displayNameLower";
    orderDirection = "asc";
    filters.push(Filter.where("displayNameLower", ">=", options.displayNamePrefix));
    filters.push(Filter.where("displayNameLower", "<", `${options.displayNamePrefix}`));
  }

  let query = partnersCollection().orderBy(orderField, orderDirection).orderBy(FieldPath.documentId()).limit(pageSize + 1);
  if (filters.length === 1) query = query.where(filters[0]!);
  else if (filters.length > 1) query = query.where(Filter.and(...filters));
  if (options.cursor) query = query.startAfter(options.cursor.orderValue, options.cursor.uid);

  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const hasMore = snapshot.docs.length > pageSize;

  const partners: PartnerDoc[] = [];
  for (const doc of pageDocs) {
    const result = partnerDocSchema.safeParse(doc.data());
    if (result.success) partners.push(result.data);
  }

  const last = pageDocs[pageDocs.length - 1];
  const nextCursor = hasMore && last ? { orderValue: String((last.data() as Record<string, unknown>)[orderField] ?? ""), uid: last.id } : null;

  return { partners, nextCursor };
}

// Bounded list of one Partner's own accounts - never unbounded (a Partner
// realistically has a handful of accounts, but the cap keeps this
// provably safe regardless). partnerRef== combined with an orderBy on a
// different field (createdAt) needs its own composite index - see
// firestore.indexes.json's "partnerAccounts" entry (partnerRef ASC,
// createdAt ASC), certified Step 8A.1.
const MAX_ACCOUNTS_PER_PARTNER = 200;
export async function listPartnerAccountDocs(partnerRef: string): Promise<PartnerAccountDoc[]> {
  const snapshot = await partnerAccountsCollection().where("partnerRef", "==", partnerRef).orderBy("createdAt", "asc").limit(MAX_ACCOUNTS_PER_PARTNER).get();
  const accounts: PartnerAccountDoc[] = [];
  for (const doc of snapshot.docs) {
    const result = partnerAccountDocSchema.safeParse(doc.data());
    if (result.success) accounts.push(result.data);
  }
  return accounts;
}
