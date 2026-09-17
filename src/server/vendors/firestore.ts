import { getAdminFirestore } from "@/server/firebase/admin";
import type { ScopeGrant } from "@/server/authz/types";
import {
  assertProductionValidPlan,
  executeBoundedIdsBranch,
  executeFirestoreBranch,
  mergeListBranches,
  nextBoundedIdsBranchCursor,
  nextFirestoreBranchCursor,
  passesBranchPostFilters,
  type BranchCursorState,
  type CompoundListCursor,
  type FirestoreFieldFilter,
  type ListBranchPlan,
  type ListQueryPlan,
  type MergeCandidate,
  type SortDirection,
} from "@/server/shared/scoped-list";
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

// Opaque to callers - one entry per active branch (see
// planVendorListQuery), keyed by branch name. Echoed back unchanged.
export type VendorListCursor = CompoundListCursor;
export type ListVendorsPage = { vendors: VendorDoc[]; nextCursor: VendorListCursor | null };

function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

export type VendorListQueryOptions = {
  actorUid: string;
  grants: ScopeGrant[];
  hasGlobal: boolean;
  status?: string;
  displayNamePrefix?: string;
  region?: string;
  ownerUid?: string;
  vendorType?: string;
};

// Step 8A.2: pure query planner - builds the branch plan only, never
// touches Firestore. Exported for unit tests (see
// src/server/shared/scoped-list-plans.test.ts). Mirrors Partners' own
// planPartnerListQuery exactly (same array-field-conflict rationale for
// the REGION/TEAM branches - see its comment), minus the PARTNER-type
// grant (Vendors deliberately never grants scope via a linked Partner -
// see buildVendorScopeFilter's old comment / Step 8A section 7) and
// minus tier/targetAudience/pendingPartnerAccountSetup (Vendor has no
// equivalent fields - only vendorType).
export function planVendorListQuery(options: VendorListQueryOptions): { plan: ListQueryPlan; orderField: string; orderDirection: SortDirection } {
  const sharedFilters: FirestoreFieldFilter[] = [];
  if (options.status) sharedFilters.push({ field: "status", op: "==", value: options.status });
  if (options.ownerUid) sharedFilters.push({ field: "ownerUid", op: "==", value: options.ownerUid });
  if (options.vendorType) sharedFilters.push({ field: "vendorType", op: "==", value: options.vendorType });

  let orderField = "createdAt";
  let orderDirection: SortDirection = "desc";
  if (options.displayNamePrefix) {
    orderField = "displayNameLower";
    orderDirection = "asc";
    sharedFilters.push({ field: "displayNameLower", op: ">=", value: options.displayNamePrefix });
    sharedFilters.push({ field: "displayNameLower", op: "<", value: options.displayNamePrefix });
  }

  const regionArrayContains: FirestoreFieldFilter | null = options.region ? { field: "regionIds", op: "array-contains", value: options.region } : null;
  const branches: ListBranchPlan[] = [];

  const explicitVendorUids = [
    ...new Set(options.grants.filter((g): g is Extract<ScopeGrant, { type: "EXPLICIT_RECORD" }> => g.type === "EXPLICIT_RECORD" && g.resourceType === "vendor").map((g) => g.resourceId)),
  ].slice(0, MAX_SCOPE_IN_VALUES);

  if (options.hasGlobal) {
    branches.push({
      kind: "firestore-query",
      name: "main",
      pushedFilters: [...sharedFilters, ...(regionArrayContains ? [regionArrayContains] : [])],
      postFilters: [],
      excludePostFilters: [],
      orderField,
      orderDirection,
    });
    return { plan: { branches }, orderField, orderDirection };
  }

  const selfGranted = options.grants.some((g) => g.type === "SELF");
  const grantedRegions = [...new Set(options.grants.filter((g): g is Extract<ScopeGrant, { type: "REGION" }> => g.type === "REGION").map((g) => g.region))].slice(0, MAX_SCOPE_IN_VALUES);
  const grantedTeams = [...new Set(options.grants.filter((g): g is Extract<ScopeGrant, { type: "TEAM" }> => g.type === "TEAM").map((g) => g.teamId))].slice(0, MAX_SCOPE_IN_VALUES);
  const regionFilterGranted = options.region ? grantedRegions.includes(options.region) : false;

  if (options.region && regionFilterGranted) {
    branches.push({ kind: "firestore-query", name: "main", pushedFilters: [...sharedFilters, regionArrayContains!], postFilters: [], excludePostFilters: [], orderField, orderDirection });
    return { plan: { branches }, orderField, orderDirection };
  }

  const selfExclude: FirestoreFieldFilter = { field: "ownerUid", op: "==", value: options.actorUid };
  const regionExclude: FirestoreFieldFilter | null = grantedRegions.length > 0 ? { field: "regionIds", op: "array-contains-any", value: grantedRegions } : null;
  const teamExclude: FirestoreFieldFilter | null = grantedTeams.length > 0 ? { field: "teamIds", op: "array-contains-any", value: grantedTeams } : null;

  if (selfGranted) {
    branches.push({
      kind: "firestore-query",
      name: "self",
      pushedFilters: [selfExclude, ...sharedFilters, ...(regionArrayContains ? [regionArrayContains] : [])],
      postFilters: [],
      excludePostFilters: [],
      orderField,
      orderDirection,
    });
  }

  if (!options.region && regionExclude) {
    branches.push({
      kind: "firestore-query",
      name: "region",
      pushedFilters: [regionExclude, ...sharedFilters],
      postFilters: [],
      excludePostFilters: selfGranted ? [selfExclude] : [],
      orderField,
      orderDirection,
    });
  }

  if (teamExclude) {
    branches.push({
      kind: "firestore-query",
      name: "team",
      pushedFilters: [teamExclude, ...sharedFilters],
      postFilters: options.region ? [regionArrayContains!] : [],
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(!options.region && regionExclude ? [regionExclude] : [])],
      orderField,
      orderDirection,
    });
  }

  if (explicitVendorUids.length > 0) {
    branches.push({
      kind: "bounded-ids",
      name: "explicit",
      ids: explicitVendorUids,
      postFilters: [...sharedFilters, ...(regionArrayContains ? [regionArrayContains] : [])],
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(regionExclude ? [regionExclude] : []), ...(teamExclude ? [teamExclude] : [])],
    });
  }

  return { plan: { branches }, orderField, orderDirection };
}

// Bounded cursor pagination, scope-constrained BEFORE retrieval - never a
// browser or server fetch-all followed by in-memory filtering. Mirrors
// Partners' listPartnerDocs exactly - see planVendorListQuery's own
// comment for the branch-decomposition rationale.
export async function listVendorDocs(options: VendorListQueryOptions & { limit: number; cursor?: VendorListCursor }): Promise<ListVendorsPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_VENDOR_PAGE_SIZE));
  const { plan, orderField, orderDirection } = planVendorListQuery(options);
  assertProductionValidPlan(plan);
  if (plan.branches.length === 0) return { vendors: [], nextCursor: null };

  const collection = vendorsCollection();
  const cursorIn = options.cursor ?? {};
  const branchBatches: Array<{ name: string; items: MergeCandidate<VendorDoc>[] }> = [];
  const nextCursorBuilders: Array<(consumed: number) => [string, BranchCursorState] | null> = [];

  for (const branch of plan.branches) {
    if (branch.kind === "bounded-ids") {
      const previous = cursorIn[branch.name];
      if (previous && "exhausted" in previous) continue;
      const previousIndex = previous && "index" in previous ? previous.index : 0;

      const rawDocs = await executeBoundedIdsBranch(collection, branch);
      const survivors: MergeCandidate<VendorDoc>[] = [];
      for (const doc of rawDocs) {
        const data = doc.data();
        if (!passesBranchPostFilters(data, branch)) continue;
        const parsed = vendorDocSchema.safeParse(data);
        if (!parsed.success) continue;
        survivors.push({ doc: parsed.data, sortValue: String(readPath(data, orderField) ?? ""), uid: doc.id });
      }
      survivors.sort((a, b) => {
        if (a.sortValue !== b.sortValue) return orderDirection === "asc" ? (a.sortValue < b.sortValue ? -1 : 1) : a.sortValue < b.sortValue ? 1 : -1;
        return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
      });

      const remaining = survivors.slice(previousIndex);
      branchBatches.push({ name: branch.name, items: remaining });
      nextCursorBuilders.push((consumedHere: number) => [branch.name, nextBoundedIdsBranchCursor(previousIndex, consumedHere, survivors.length)]);
      continue;
    }

    const previous = cursorIn[branch.name];
    if (previous && "exhausted" in previous) continue;
    const queryCursor = previous && "orderValue" in previous ? previous : undefined;

    const { docs: rawDocs, hasMoreInBranch } = await executeFirestoreBranch(collection, branch, queryCursor, pageSize);
    const survivorRawIndexes: number[] = [];
    const survivors: MergeCandidate<VendorDoc>[] = [];
    rawDocs.forEach((doc, rawIndex) => {
      const data = doc.data();
      if (!passesBranchPostFilters(data, branch)) return;
      const parsed = vendorDocSchema.safeParse(data);
      if (!parsed.success) return;
      survivorRawIndexes.push(rawIndex);
      survivors.push({ doc: parsed.data, sortValue: String(readPath(data, orderField) ?? ""), uid: doc.id });
    });

    branchBatches.push({ name: branch.name, items: survivors });
    nextCursorBuilders.push((consumedHere: number) => {
      const state = nextFirestoreBranchCursor({
        fetch: { rawDocs: rawDocs.map((d) => ({ orderValue: String(readPath(d.data(), orderField) ?? ""), uid: d.id })), hasMoreInBranch },
        survivorRawIndexes,
        consumed: consumedHere,
        previousCursor: queryCursor,
      });
      return state === undefined ? null : [branch.name, state];
    });
  }

  const { page, consumed } = mergeListBranches(branchBatches, pageSize, orderDirection);

  const nextCursor: CompoundListCursor = {};
  let anyResumable = false;
  branchBatches.forEach((batch, i) => {
    const entry = nextCursorBuilders[i]!(consumed[batch.name] ?? 0);
    if (!entry) return;
    const [name, state] = entry;
    nextCursor[name] = state;
    if (!("exhausted" in state)) anyResumable = true;
  });

  return { vendors: page, nextCursor: page.length === pageSize && anyResumable ? nextCursor : null };
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
