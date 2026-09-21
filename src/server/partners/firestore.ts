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
  toValueArray,
} from "@/server/shared/scoped-list";
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

// Step 10B: bounded bulk label resolution for a Workspace page of some
// OTHER domain's rows (e.g. Assignment) that each carry a partnerRef -
// never one query per row, same chunking discipline as Campaigns' own
// getCampaignDocsByRefs.
export async function getPartnerDocsByRefs(partnerRefs: string[]): Promise<Map<string, PartnerDoc>> {
  const unique = [...new Set(partnerRefs)];
  const result = new Map<string, PartnerDoc>();
  for (let i = 0; i < unique.length; i += MAX_SCOPE_IN_VALUES) {
    const chunk = unique.slice(i, i + MAX_SCOPE_IN_VALUES);
    const snapshot = await partnersCollection().where("partnerRef", "in", chunk).get();
    for (const doc of snapshot.docs) {
      const parsed = partnerDocSchema.safeParse(doc.data());
      if (parsed.success) result.set(parsed.data.partnerRef, parsed.data);
    }
  }
  return result;
}

// Step 14B.1: bounded EXACT-equality lookups for the Finance Agreement onboarding wrapper (never a fuzzy / prefix search, never unbounded).
// `displayNameLower` is the owning module's own normalized-name field; both queries are equality-only (no composite index needed).
export const MAX_PARTNER_EXACT_LOOKUP = 10;

export async function findPartnerDocsByDisplayNameLower(displayNameLower: string, limit: number = MAX_PARTNER_EXACT_LOOKUP): Promise<PartnerDoc[]> {
  const snapshot = await partnersCollection().where("displayNameLower", "==", displayNameLower).limit(Math.max(1, Math.min(limit, MAX_PARTNER_EXACT_LOOKUP))).get();
  return snapshot.docs.flatMap((doc) => {
    const parsed = partnerDocSchema.safeParse(doc.data());
    return parsed.success ? [parsed.data] : [];
  });
}

// Records THIS user created with exactly this normalized name (the onboarding crash-recovery "adopt" lookup).
export async function findPartnerDocsCreatedByUser(createdByUserRef: string, displayNameLower: string, limit: number = MAX_PARTNER_EXACT_LOOKUP): Promise<PartnerDoc[]> {
  const snapshot = await partnersCollection().where("createdByUserRef", "==", createdByUserRef).where("displayNameLower", "==", displayNameLower).limit(Math.max(1, Math.min(limit, MAX_PARTNER_EXACT_LOOKUP))).get();
  return snapshot.docs.flatMap((doc) => {
    const parsed = partnerDocSchema.safeParse(doc.data());
    return parsed.success ? [parsed.data] : [];
  });
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

// Step 10B: same bounded bulk-chunked pattern as getPartnerDocsByRefs, for
// a page of some other domain's rows that each carry partnerAccountRefs.
export async function getPartnerAccountDocsByRefs(partnerAccountRefs: string[]): Promise<Map<string, PartnerAccountDoc>> {
  const unique = [...new Set(partnerAccountRefs)];
  const result = new Map<string, PartnerAccountDoc>();
  for (let i = 0; i < unique.length; i += MAX_SCOPE_IN_VALUES) {
    const chunk = unique.slice(i, i + MAX_SCOPE_IN_VALUES);
    const snapshot = await partnerAccountsCollection().where("partnerAccountRef", "in", chunk).get();
    for (const doc of snapshot.docs) {
      const parsed = partnerAccountDocSchema.safeParse(doc.data());
      if (parsed.success) result.set(parsed.data.partnerAccountRef, parsed.data);
    }
  }
  return result;
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

// Opaque to callers - one entry per active branch (see
// planPartnerListQuery), keyed by branch name. Echoed back unchanged.
export type PartnerListCursor = CompoundListCursor;
export type ListPartnersPage = { partners: PartnerDoc[]; nextCursor: PartnerListCursor | null };

function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

export type PartnerListQueryOptions = {
  actorUid: string;
  grants: ScopeGrant[];
  hasGlobal: boolean;
  status?: string;
  displayNamePrefix?: string;
  region?: string | string[];
  ownerUid?: string;
  tier?: string;
  targetAudience?: string | string[];
  pendingPartnerAccountSetup?: boolean;
};

// Step 8A.2: pure query planner - builds the branch plan only, never
// touches Firestore. Exported for unit tests (see
// src/server/shared/scoped-list-plans.test.ts). Replaces the old single
// Filter.or(...)-combined query - see Discovery's planLeadListQuery and
// scoped-list.ts's header comment for the full design rationale.
//
// Unlike Discovery, Partners' regionIds/teamIds are ARRAY fields
// (array-contains-any for a grant, array-contains for the operator's own
// "region" filter) - Firestore allows at most one array-type filter per
// query, full stop, regardless of field. That means a selected region
// filter can never combine with EITHER the REGION branch's
// array-contains-any (same field) OR the TEAM branch's
// array-contains-any (a different field, but still a second array-type
// filter) - so when a region filter is active and not already granted,
// the REGION branch is dropped entirely and the TEAM branch pushes only
// its own teamIds condition to Firestore, applying the region condition
// as an in-memory postFilter instead (see the "team" branch below).
export function planPartnerListQuery(options: PartnerListQueryOptions): { plan: ListQueryPlan; orderField: string; orderDirection: SortDirection } {
  const sharedFilters: FirestoreFieldFilter[] = [];
  if (options.status) sharedFilters.push({ field: "status", op: "==", value: options.status });
  if (options.ownerUid) sharedFilters.push({ field: "ownerUid", op: "==", value: options.ownerUid });
  if (options.tier) sharedFilters.push({ field: "tier", op: "==", value: options.tier });
  if (options.pendingPartnerAccountSetup) sharedFilters.push({ field: "pendingPartnerAccountSetup", op: "==", value: true });

  let orderField = "createdAt";
  let orderDirection: SortDirection = "desc";
  if (options.displayNamePrefix) {
    orderField = "displayNameLower";
    orderDirection = "asc";
    sharedFilters.push({ field: "displayNameLower", op: ">=", value: options.displayNamePrefix });
    // The standard Firestore "prefix range" upper bound - see Discovery's
    // planLeadListQuery for why this can't just be the bare prefix again
    // (that combination is never satisfiable - Step 8B found and fixed
    // this while building the Vendor<->Partner picker).
    sharedFilters.push({ field: "displayNameLower", op: "<", value: `${options.displayNamePrefix}` });
  }

  const requestedRegions = toValueArray(options.region);
  const regionArrayContains: FirestoreFieldFilter | null = requestedRegions.length > 0 ? { field: "regionIds", op: "array-contains-any", value: requestedRegions } : null;

  // targetAudience is now also an array field (a Partner can span more
  // than one segment) - an operator-selected filter means "any of
  // these", via array-contains-any, the same idiom as region. Firestore
  // still allows only one array-type filter per query, so in a branch
  // that has no array-type filter of its own already spoken for (main/
  // self below), region keeps the one pushed slot when both are active
  // (it was already the established citizen here) and targetAudience is
  // applied as a postFilter instead - bounded and safe (never wrong
  // data, at most an extra page turn on the rare combination of both
  // filters at once), the same trade-off already accepted for
  // region-vs-team below. In every branch that already carries its OWN
  // mandatory array filter (region/team/main-region-granted), a
  // targetAudience filter always defers to postFilter - it never gets a
  // chance to be pushed there regardless of whether region is active.
  const requestedTargetAudiences = toValueArray(options.targetAudience);
  const targetAudienceArrayContains: FirestoreFieldFilter | null =
    requestedTargetAudiences.length > 0 ? { field: "targetAudience", op: "array-contains-any", value: requestedTargetAudiences } : null;
  const pushableArrayFilter = (): FirestoreFieldFilter | null => regionArrayContains ?? targetAudienceArrayContains;
  const deferredArrayFilter = (): FirestoreFieldFilter[] => (regionArrayContains && targetAudienceArrayContains ? [targetAudienceArrayContains] : []);

  const branches: ListBranchPlan[] = [];

  const explicitPartnerUids = [
    ...new Set([
      ...options.grants.filter((g): g is Extract<ScopeGrant, { type: "PARTNER" }> => g.type === "PARTNER").map((g) => g.partnerId),
      ...options.grants.filter((g): g is Extract<ScopeGrant, { type: "EXPLICIT_RECORD" }> => g.type === "EXPLICIT_RECORD" && g.resourceType === "partner").map((g) => g.resourceId),
    ]),
  ].slice(0, MAX_SCOPE_IN_VALUES);

  if (options.hasGlobal) {
    const pushed = pushableArrayFilter();
    branches.push({
      kind: "firestore-query",
      name: "main",
      pushedFilters: [...sharedFilters, ...(pushed ? [pushed] : [])],
      postFilters: deferredArrayFilter(),
      excludePostFilters: [],
      orderField,
      orderDirection,
    });
    return { plan: { branches }, orderField, orderDirection };
  }

  const selfGranted = options.grants.some((g) => g.type === "SELF");
  const grantedRegions = [...new Set(options.grants.filter((g): g is Extract<ScopeGrant, { type: "REGION" }> => g.type === "REGION").map((g) => g.region))].slice(0, MAX_SCOPE_IN_VALUES);
  const grantedTeams = [...new Set(options.grants.filter((g): g is Extract<ScopeGrant, { type: "TEAM" }> => g.type === "TEAM").map((g) => g.teamId))].slice(0, MAX_SCOPE_IN_VALUES);
  const regionFilterGranted = requestedRegions.length > 0 && requestedRegions.every((r) => grantedRegions.includes(r));

  if (requestedRegions.length > 0 && regionFilterGranted) {
    // The REGION grant alone authorizes every Partner in this region,
    // regardless of ownerUid/teamIds - a strict superset of what
    // SELF/TEAM/EXPLICIT could otherwise contribute once also filtered
    // to this same region, so this fully replaces every other branch.
    branches.push({
      kind: "firestore-query",
      name: "main",
      pushedFilters: [...sharedFilters, regionArrayContains!],
      postFilters: targetAudienceArrayContains ? [targetAudienceArrayContains] : [],
      excludePostFilters: [],
      orderField,
      orderDirection,
    });
    return { plan: { branches }, orderField, orderDirection };
  }

  const selfExclude: FirestoreFieldFilter = { field: "ownerUid", op: "==", value: options.actorUid };
  const regionExclude: FirestoreFieldFilter | null = grantedRegions.length > 0 ? { field: "regionIds", op: "array-contains-any", value: grantedRegions } : null;
  const teamExclude: FirestoreFieldFilter | null = grantedTeams.length > 0 ? { field: "teamIds", op: "array-contains-any", value: grantedTeams } : null;

  if (selfGranted) {
    const pushed = pushableArrayFilter();
    branches.push({
      kind: "firestore-query",
      name: "self",
      pushedFilters: [selfExclude, ...sharedFilters, ...(pushed ? [pushed] : [])],
      postFilters: deferredArrayFilter(),
      excludePostFilters: [],
      orderField,
      orderDirection,
    });
  }

  // Only reachable when no region filter is active, or one is active
  // but not covered by a REGION grant (the fully-granted case already
  // returned above) - array-contains-any can't combine with a selected
  // region's own array-contains on the same field. Excludes anything the
  // higher-priority "self" branch would already surface.
  if (requestedRegions.length === 0 && regionExclude) {
    branches.push({
      kind: "firestore-query",
      name: "region",
      pushedFilters: [regionExclude, ...sharedFilters],
      postFilters: targetAudienceArrayContains ? [targetAudienceArrayContains] : [],
      excludePostFilters: selfGranted ? [selfExclude] : [],
      orderField,
      orderDirection,
    });
  }

  // teamIds array-contains-any can never combine with a selected
  // region's regionIds array-contains in one Firestore query (only one
  // array-type filter per query, regardless of field) - so the region
  // condition, when active, is applied as a postFilter here instead of
  // being pushed alongside teamIds. This may under-fill a page relative
  // to the requested size in the rare case of a TEAM-only actor
  // combining a region filter with very few matching records in the
  // fetched window - bounded and safe (never wrong data, at most an
  // extra page turn), never a whole-collection scan.
  if (teamExclude) {
    branches.push({
      kind: "firestore-query",
      name: "team",
      pushedFilters: [teamExclude, ...sharedFilters],
      postFilters: [...(requestedRegions.length > 0 ? [regionArrayContains!] : []), ...(targetAudienceArrayContains ? [targetAudienceArrayContains] : [])],
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(requestedRegions.length === 0 && regionExclude ? [regionExclude] : [])],
      orderField,
      orderDirection,
    });
  }

  if (explicitPartnerUids.length > 0) {
    branches.push({
      kind: "bounded-ids",
      name: "explicit",
      ids: explicitPartnerUids,
      postFilters: [...sharedFilters, ...(regionArrayContains ? [regionArrayContains] : []), ...(targetAudienceArrayContains ? [targetAudienceArrayContains] : [])],
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(regionExclude ? [regionExclude] : []), ...(teamExclude ? [teamExclude] : [])],
    });
  }

  return { plan: { branches }, orderField, orderDirection };
}

// Bounded cursor pagination, scope-constrained BEFORE retrieval - never a
// browser or server fetch-all followed by in-memory filtering.
// planPartnerListQuery decomposes scope into independent, individually-
// valid branches (see its own comment), each executed and cursor-
// paginated on its own, then merged here into one globally-ordered page.
// A non-GLOBAL actor with zero relevant grants gets an empty page
// without any Firestore read at all.
export async function listPartnerDocs(options: PartnerListQueryOptions & { limit: number; cursor?: PartnerListCursor }): Promise<ListPartnersPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_PARTNER_PAGE_SIZE));
  const { plan, orderField, orderDirection } = planPartnerListQuery(options);
  assertProductionValidPlan(plan);
  if (plan.branches.length === 0) return { partners: [], nextCursor: null };

  const collection = partnersCollection();
  const cursorIn = options.cursor ?? {};
  const branchBatches: Array<{ name: string; items: MergeCandidate<PartnerDoc>[] }> = [];
  const nextCursorBuilders: Array<(consumed: number) => [string, BranchCursorState] | null> = [];

  for (const branch of plan.branches) {
    if (branch.kind === "bounded-ids") {
      const previous = cursorIn[branch.name];
      if (previous && "exhausted" in previous) continue;
      const previousIndex = previous && "index" in previous ? previous.index : 0;

      const rawDocs = await executeBoundedIdsBranch(collection, branch);
      const survivors: MergeCandidate<PartnerDoc>[] = [];
      for (const doc of rawDocs) {
        const data = doc.data();
        if (!passesBranchPostFilters(data, branch)) continue;
        const parsed = partnerDocSchema.safeParse(data);
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
    const survivors: MergeCandidate<PartnerDoc>[] = [];
    rawDocs.forEach((doc, rawIndex) => {
      const data = doc.data();
      if (!passesBranchPostFilters(data, branch)) return;
      const parsed = partnerDocSchema.safeParse(data);
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

  return { partners: page, nextCursor: page.length === pageSize && anyResumable ? nextCursor : null };
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
