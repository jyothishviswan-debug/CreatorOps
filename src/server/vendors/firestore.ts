import { FieldPath, Filter } from "firebase-admin/firestore";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { ScopeGrant } from "@/server/authz/types";
import { vendorDocSchema, vendorPartnerLinkDocSchema, type VendorDoc, type VendorPartnerLinkDoc } from "./types";

// Step 8A.1: restricted financial identity moved to the one canonical,
// cross-domain restrictedFinancialIdentities collection - see
// @/server/shared/restricted-financial-identity.ts. No longer listed
// here; this module never owns it (the old
// "restrictedVendorFinancialIdentities" parallel collection is gone).
export const VENDORS_COLLECTIONS = {
  vendors: "vendors",
  vendorEvents: "events", // subcollection name under vendors/{uid}
  vendorPartnerLinks: "vendorPartnerLinks",
} as const;

export const MAX_VENDOR_PAGE_SIZE = 100;
export const DEFAULT_VENDOR_PAGE_SIZE = 20;
export const MAX_VENDOR_LINK_PAGE_SIZE = 100;

// Firestore's `in` operator caps at 30 values per query - same bounded
// discipline as Partners'/Discovery's own firestore.ts.
const MAX_SCOPE_IN_VALUES = 30;

export function vendorsCollection() {
  return getAdminFirestore().collection(VENDORS_COLLECTIONS.vendors);
}

export function vendorEventsCollection(vendorUid: string) {
  return vendorsCollection().doc(vendorUid).collection(VENDORS_COLLECTIONS.vendorEvents);
}

export function vendorPartnerLinksCollection() {
  return getAdminFirestore().collection(VENDORS_COLLECTIONS.vendorPartnerLinks);
}

export async function getVendorDocByUid(uid: string): Promise<VendorDoc | null> {
  const snapshot = await vendorsCollection().doc(uid).get();
  if (!snapshot.exists) return null;
  const result = vendorDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Resolves a Vendor by its opaque, browser-facing vendorRef instead of
// the internal Firestore doc id - same idiom as getPartnerDocByRef. A
// tampered or made-up token simply matches no document (never leaks
// whether a differently-scoped Vendor exists).
export async function getVendorDocByRef(vendorRef: string): Promise<VendorDoc | null> {
  const snapshot = await vendorsCollection().where("vendorRef", "==", vendorRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = vendorDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export async function getVendorPartnerLinkDocByUid(uid: string): Promise<VendorPartnerLinkDoc | null> {
  const snapshot = await vendorPartnerLinksCollection().doc(uid).get();
  if (!snapshot.exists) return null;
  const result = vendorPartnerLinkDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getVendorPartnerLinkDocByRef(vendorPartnerLinkRef: string): Promise<VendorPartnerLinkDoc | null> {
  const snapshot = await vendorPartnerLinksCollection().where("vendorPartnerLinkRef", "==", vendorPartnerLinkRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = vendorPartnerLinkDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export type VendorMutationResult = { kind: "ok"; doc: VendorDoc } | { kind: "stale" } | { kind: "not_found" };

// Shared transactional "read current, verify optimistic version, apply a
// pure patch, write" primitive - same discipline as Partners' own
// runPartnerMutation. Used by every ordinary Vendor field mutation;
// lifecycle/governance transitions (which need extra preconditions) run
// their own transactions instead (see vendor-lifecycle-service.ts).
export async function runVendorMutation(vendorUid: string, expectedVersion: number, mutate: (current: VendorDoc) => VendorDoc): Promise<VendorMutationResult> {
  const db = getAdminFirestore();
  const docRef = vendorsCollection().doc(vendorUid);

  return db.runTransaction<VendorMutationResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsed = vendorDocSchema.safeParse(snap.data());
    if (!parsed.success) return { kind: "not_found" };
    const current = parsed.data;

    if (current.version !== expectedVersion) return { kind: "stale" };

    const next = { ...mutate(current), version: current.version + 1 };
    tx.set(docRef, next);
    return { kind: "ok", doc: next };
  });
}

export type VendorPartnerLinkMutationResult = { kind: "ok"; doc: VendorPartnerLinkDoc } | { kind: "stale" } | { kind: "not_found" };

export async function runVendorPartnerLinkMutation(
  linkUid: string,
  expectedVersion: number,
  mutate: (current: VendorPartnerLinkDoc) => VendorPartnerLinkDoc,
): Promise<VendorPartnerLinkMutationResult> {
  const db = getAdminFirestore();
  const docRef = vendorPartnerLinksCollection().doc(linkUid);

  return db.runTransaction<VendorPartnerLinkMutationResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsed = vendorPartnerLinkDocSchema.safeParse(snap.data());
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
export type VendorListCursor = { orderValue: string; uid: string };
export type ListVendorsPage = { vendors: VendorDoc[]; nextCursor: VendorListCursor | null };

// Builds the OR-combined scope filter for a non-GLOBAL actor's grants -
// same construction as Partners' buildPartnerScopeFilter, adapted to the
// Vendor scope dimensions (SELF -> ownerUid ==, REGION -> regionIds
// array-contains-any, TEAM -> teamIds array-contains-any, EXPLICIT_RECORD
// (resourceType "vendor") -> document id in [...]). Deliberately does
// NOT include any PARTNER-type grant or "linked Partner in scope" check -
// Step 8A section 7's critical rule: a visible Partner relationship must
// never become a scope-escalation bridge into a Vendor's unrelated
// portfolio, so only genuine Vendor-side scope grants this. Returns null
// when the actor holds none of these - the caller must treat that as
// "return an empty page" (no missing-scope => global fallback).
function buildVendorScopeFilter(actorUid: string, grants: ScopeGrant[]): Filter | null {
  const branches: Filter[] = [];

  if (grants.some((g) => g.type === "SELF")) {
    branches.push(Filter.where("ownerUid", "==", actorUid));
  }

  const regions = [...new Set(grants.filter((g): g is Extract<ScopeGrant, { type: "REGION" }> => g.type === "REGION").map((g) => g.region))].slice(0, MAX_SCOPE_IN_VALUES);
  if (regions.length > 0) branches.push(Filter.where("regionIds", "array-contains-any", regions));

  const teamIds = [...new Set(grants.filter((g): g is Extract<ScopeGrant, { type: "TEAM" }> => g.type === "TEAM").map((g) => g.teamId))].slice(0, MAX_SCOPE_IN_VALUES);
  if (teamIds.length > 0) branches.push(Filter.where("teamIds", "array-contains-any", teamIds));

  const explicitVendorUids = [
    ...new Set(
      grants.filter((g): g is Extract<ScopeGrant, { type: "EXPLICIT_RECORD" }> => g.type === "EXPLICIT_RECORD" && g.resourceType === "vendor").map((g) => g.resourceId),
    ),
  ].slice(0, MAX_SCOPE_IN_VALUES);
  if (explicitVendorUids.length > 0) branches.push(Filter.where(FieldPath.documentId(), "in", explicitVendorUids));

  if (branches.length === 0) return null;
  return branches.length === 1 ? branches[0]! : Filter.or(...branches);
}

// Bounded cursor pagination, scope-constrained BEFORE retrieval - never a
// browser or server fetch-all followed by in-memory filtering. Mirrors
// Partners' listPartnerDocs exactly. Composite indexes: one per {SELF/
// REGION/TEAM scope branch} x {createdAt-desc, displayName search order},
// one status+branch+createdAt layer, one standalone vendorType+createdAt
// entry - see firestore.indexes.json's "vendors" entries (certified Step
// 8A.1). The EXPLICIT_RECORD scope branch's documentId()-in stays
// intentionally unindexed here, same accepted gap as Partners' own
// PARTNER/EXPLICIT_RECORD branch.
export async function listVendorDocs(options: {
  limit: number;
  cursor?: VendorListCursor;
  actorUid: string;
  grants: ScopeGrant[];
  hasGlobal: boolean;
  status?: string;
  displayNamePrefix?: string;
  region?: string;
  ownerUid?: string;
  vendorType?: string;
}): Promise<ListVendorsPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_VENDOR_PAGE_SIZE));

  let scopeFilter: Filter | null = null;
  if (!options.hasGlobal) {
    scopeFilter = buildVendorScopeFilter(options.actorUid, options.grants);
    if (!scopeFilter) return { vendors: [], nextCursor: null };
  }

  const filters: Filter[] = [];
  if (scopeFilter) filters.push(scopeFilter);
  if (options.status) filters.push(Filter.where("status", "==", options.status));
  if (options.region) filters.push(Filter.where("regionIds", "array-contains", options.region));
  if (options.ownerUid) filters.push(Filter.where("ownerUid", "==", options.ownerUid));
  if (options.vendorType) filters.push(Filter.where("vendorType", "==", options.vendorType));

  let orderField = "createdAt";
  let orderDirection: FirebaseFirestore.OrderByDirection = "desc";
  if (options.displayNamePrefix) {
    orderField = "displayNameLower";
    orderDirection = "asc";
    filters.push(Filter.where("displayNameLower", ">=", options.displayNamePrefix));
    filters.push(Filter.where("displayNameLower", "<", `${options.displayNamePrefix}`));
  }

  let query = vendorsCollection().orderBy(orderField, orderDirection).orderBy(FieldPath.documentId()).limit(pageSize + 1);
  if (filters.length === 1) query = query.where(filters[0]!);
  else if (filters.length > 1) query = query.where(Filter.and(...filters));
  if (options.cursor) query = query.startAfter(options.cursor.orderValue, options.cursor.uid);

  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const hasMore = snapshot.docs.length > pageSize;

  const vendors: VendorDoc[] = [];
  for (const doc of pageDocs) {
    const result = vendorDocSchema.safeParse(doc.data());
    if (result.success) vendors.push(result.data);
  }

  const last = pageDocs[pageDocs.length - 1];
  const nextCursor = hasMore && last ? { orderValue: String((last.data() as Record<string, unknown>)[orderField] ?? ""), uid: last.id } : null;

  return { vendors, nextCursor };
}

// Bounded list of one Vendor's own relationship links - never unbounded.
// vendorRef== combined with an orderBy on a different field (createdAt)
// needs its own composite index - see firestore.indexes.json's
// "vendorPartnerLinks" vendorRef+createdAt entry (certified Step 8A.1).
const MAX_LINKS_PER_VENDOR = 200;
export async function listVendorPartnerLinkDocsForVendor(vendorRef: string): Promise<VendorPartnerLinkDoc[]> {
  const snapshot = await vendorPartnerLinksCollection().where("vendorRef", "==", vendorRef).orderBy("createdAt", "asc").limit(MAX_LINKS_PER_VENDOR).get();
  const links: VendorPartnerLinkDoc[] = [];
  for (const doc of snapshot.docs) {
    const result = vendorPartnerLinkDocSchema.safeParse(doc.data());
    if (result.success) links.push(result.data);
  }
  return links;
}

// Bounded list of the links belonging to ONE Partner - this is the
// Partner-side relationship slice (Step 8A section 10). Callers MUST
// gate this with the Partner's own scope check (requirePartnerInScope),
// never a Vendor-scope check - a Partner being visible must never expose
// more than that Partner's own link rows. partnerRef== combined with an
// orderBy on a different field (createdAt) needs its own composite index
// - see firestore.indexes.json's "vendorPartnerLinks" partnerRef+
// createdAt entry (certified Step 8A.1).
const MAX_LINKS_PER_PARTNER = 200;
export async function listVendorPartnerLinkDocsForPartner(partnerRef: string): Promise<VendorPartnerLinkDoc[]> {
  const snapshot = await vendorPartnerLinksCollection().where("partnerRef", "==", partnerRef).orderBy("createdAt", "asc").limit(MAX_LINKS_PER_PARTNER).get();
  const links: VendorPartnerLinkDoc[] = [];
  for (const doc of snapshot.docs) {
    const result = vendorPartnerLinkDocSchema.safeParse(doc.data());
    if (result.success) links.push(result.data);
  }
  return links;
}
