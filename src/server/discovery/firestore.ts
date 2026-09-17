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
import { leadDocSchema, leadRestrictedKycDocSchema, type LeadDoc, type LeadRestrictedKycDoc } from "./types";

export const DISCOVERY_COLLECTIONS = {
  leads: "leads",
  leadEvents: "events", // subcollection name under leads/{uid}
  leadRestrictedKyc: "leadRestrictedKyc",
} as const;

// Bounded pagination default/ceiling - same discipline as
// src/server/authz/firestore.ts's MAX_LIST_PAGE_SIZE.
export const MAX_LEAD_PAGE_SIZE = 100;
export const DEFAULT_LEAD_PAGE_SIZE = 20;

// Firestore's `in` operator caps at 30 values per query - bounded by
// construction, never an unbounded IN list.
const MAX_SCOPE_IN_VALUES = 30;

export function leadsCollection() {
  return getAdminFirestore().collection(DISCOVERY_COLLECTIONS.leads);
}

export function leadEventsCollection(leadUid: string) {
  return leadsCollection().doc(leadUid).collection(DISCOVERY_COLLECTIONS.leadEvents);
}

export function leadRestrictedKycCollection() {
  return getAdminFirestore().collection(DISCOVERY_COLLECTIONS.leadRestrictedKyc);
}

export async function getLeadDocByUid(uid: string): Promise<LeadDoc | null> {
  const snapshot = await leadsCollection().doc(uid).get();
  if (!snapshot.exists) return null;
  const result = leadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Resolves a Lead by its opaque, browser-facing leadRef instead of the
// internal Firestore doc id - same idiom as getUserDocByRef. A tampered
// or made-up token simply matches no document.
export async function getLeadDocByRef(leadRef: string): Promise<LeadDoc | null> {
  const snapshot = await leadsCollection().where("leadRef", "==", leadRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = leadDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export async function getLeadRestrictedKycDoc(leadUid: string): Promise<LeadRestrictedKycDoc | null> {
  const snapshot = await leadRestrictedKycCollection().doc(leadUid).get();
  if (!snapshot.exists) return null;
  const result = leadRestrictedKycDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export type LeadMutationResult = { kind: "ok"; doc: LeadDoc } | { kind: "stale" } | { kind: "not_found" };

// Shared transactional "read current, verify optimistic version, apply a
// pure patch, write" primitive - reads before writes (a hard Firestore
// transaction requirement), used by every ordinary field/evidence
// mutation in lead-service.ts/kyc-service.ts so optimistic-concurrency
// enforcement lives in exactly one place. Transitions with extra
// preconditions (lifecycle-service.ts, conversion-service.ts) run their
// own transactions instead, since they need to re-validate more than
// just the version before writing.
export async function runLeadMutation(leadUid: string, expectedVersion: number, mutate: (current: LeadDoc) => LeadDoc): Promise<LeadMutationResult> {
  const db = getAdminFirestore();
  const docRef = leadsCollection().doc(leadUid);

  return db.runTransaction<LeadMutationResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsed = leadDocSchema.safeParse(snap.data());
    if (!parsed.success) return { kind: "not_found" };
    const current = parsed.data;

    if (current.version !== expectedVersion) return { kind: "stale" };

    // Optimistic-concurrency bump lives here, once, rather than in every
    // caller's own `mutate` - a caller only needs to describe WHAT
    // changes, never remember to also bump the version.
    const next = { ...mutate(current), version: current.version + 1 };
    tx.set(docRef, next);
    return { kind: "ok", doc: next };
  });
}

// Opaque to callers - one entry per active branch (see
// planLeadListQuery), keyed by branch name. The client only ever echoes
// it back unchanged, never inspects or constructs it.
export type LeadListCursor = CompoundListCursor;

export type ListLeadsPage = { leads: LeadDoc[]; nextCursor: LeadListCursor | null };

function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

export type LeadListQueryOptions = {
  actorUid: string;
  grants: ScopeGrant[];
  hasGlobal: boolean;
  lifecycle?: string;
  region?: string;
  platform?: string;
  assignedToMe?: boolean;
  displayNamePrefix?: string;
  followUpDue?: boolean;
};

// Step 8A.2: pure query planner - builds the branch plan only, never
// touches Firestore. Exported so unit tests can assert on its shape
// directly (see src/server/shared/scoped-list-plans.test.ts) without the
// emulator. Replaces the old single Filter.or(...)-combined query: that
// design could produce two Firestore-invalid shapes once a `region`
// filter was combined with the REGION scope branch (two conditions on
// the same field from one Filter.or arm) or once EXPLICIT_RECORD grants
// were combined with orderBy (documentId() "in" has no valid composite
// index alongside a different order field). Every branch below is
// independently valid by construction (enforced by
// assertProductionValidPlan, called from listLeadDocs before any read) -
// see scoped-list.ts's own header comment for the full design rationale.
//
// Discovery's `region`/`teamId` are single scalar fields (`in` for scope
// grants, `==` for the operator's own filter) - unlike Partners'/
// Vendors' array-valued regionIds/teamIds, an `in` and a same-field `==`
// filter don't hit Firestore's "one array/IN-type filter per query"
// restriction, so only the REGION branch (not TEAM) ever needs the
// simplify-or-drop treatment below.
export function planLeadListQuery(options: LeadListQueryOptions): { plan: ListQueryPlan; orderField: string; orderDirection: SortDirection } {
  const sharedFilters: FirestoreFieldFilter[] = [];
  if (options.lifecycle) sharedFilters.push({ field: "lifecycle", op: "==", value: options.lifecycle });
  if (options.platform) sharedFilters.push({ field: "platform", op: "==", value: options.platform });
  if (options.assignedToMe) sharedFilters.push({ field: "ownerUid", op: "==", value: options.actorUid });

  let orderField = "createdAt";
  let orderDirection: SortDirection = "desc";
  if (options.displayNamePrefix) {
    orderField = "displayNameLower";
    orderDirection = "asc";
    sharedFilters.push({ field: "displayNameLower", op: ">=", value: options.displayNamePrefix });
    // The standard Firestore "prefix range" upper bound -  sorts
    // after every realistic character, so this matches every string
    // starting with the prefix. A prior version of this filter used the
    // bare prefix as BOTH bounds (`>= prefix AND < prefix`), which is
    // mathematically never satisfiable - name search returned zero
    // results unconditionally. Found and fixed during Step 8B while
    // building the Vendor<->Partner picker, which depends on this
    // actually working.
    sharedFilters.push({ field: "displayNameLower", op: "<", value: `${options.displayNamePrefix}` });
  } else if (options.followUpDue) {
    orderField = "outreachSummary.nextFollowUpAt";
    orderDirection = "asc";
    sharedFilters.push({ field: "outreachSummary.nextFollowUpAt", op: "<=", value: new Date().toISOString() });
  }

  const regionEquality: FirestoreFieldFilter | null = options.region ? { field: "region", op: "==", value: options.region } : null;
  const branches: ListBranchPlan[] = [];

  const explicitLeadUids = [
    ...new Set(
      options.grants
        .filter((g): g is Extract<ScopeGrant, { type: "EXPLICIT_RECORD" }> => g.type === "EXPLICIT_RECORD" && g.resourceType === "lead")
        .map((g) => g.resourceId),
    ),
  ].slice(0, MAX_SCOPE_IN_VALUES);

  if (options.hasGlobal) {
    branches.push({
      kind: "firestore-query",
      name: "main",
      pushedFilters: [...sharedFilters, ...(regionEquality ? [regionEquality] : [])],
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
    // The REGION grant alone authorizes every Lead in this region,
    // regardless of ownerUid/teamId - a strict superset of what
    // SELF/TEAM/EXPLICIT_RECORD could otherwise contribute once also
    // filtered to this same region, so this fully replaces every other
    // branch instead of stacking a same-field `in` + `==` OR arm.
    branches.push({ kind: "firestore-query", name: "main", pushedFilters: [...sharedFilters, regionEquality!], postFilters: [], excludePostFilters: [], orderField, orderDirection });
    return { plan: { branches }, orderField, orderDirection };
  }

  const selfExclude: FirestoreFieldFilter = { field: "ownerUid", op: "==", value: options.actorUid };
  const regionExclude: FirestoreFieldFilter | null = grantedRegions.length > 0 ? { field: "region", op: "in", value: grantedRegions } : null;
  const teamExclude: FirestoreFieldFilter | null = grantedTeams.length > 0 ? { field: "teamId", op: "in", value: grantedTeams } : null;

  if (selfGranted) {
    branches.push({
      kind: "firestore-query",
      name: "self",
      pushedFilters: [selfExclude, ...sharedFilters, ...(regionEquality ? [regionEquality] : [])],
      postFilters: [],
      excludePostFilters: [],
      orderField,
      orderDirection,
    });
  }

  // Only reachable when no region filter is selected, or one is
  // selected but not covered by a REGION grant (the fully-granted case
  // already returned above) - so this branch is never redundant with
  // "main". Excludes anything the (higher-priority) "self" branch would
  // already surface, keeping branches disjoint without cross-branch
  // dedup.
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
      pushedFilters: [teamExclude, ...sharedFilters, ...(regionEquality ? [regionEquality] : [])],
      postFilters: [],
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(!options.region && regionExclude ? [regionExclude] : [])],
      orderField,
      orderDirection,
    });
  }

  if (explicitLeadUids.length > 0) {
    branches.push({
      kind: "bounded-ids",
      name: "explicit",
      ids: explicitLeadUids,
      postFilters: [...sharedFilters, ...(regionEquality ? [regionEquality] : [])],
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(regionExclude ? [regionExclude] : []), ...(teamExclude ? [teamExclude] : [])],
    });
  }

  return { plan: { branches }, orderField, orderDirection };
}

// Bounded cursor pagination, never a whole-collection fetch, never a
// broad fetch followed by in-memory scope/filter narrowing. `hasGlobal`
// short-circuits to a single unscoped branch; otherwise planLeadListQuery
// decomposes scope into independent, individually-valid branches (see
// its own comment), each executed and cursor-paginated on its own, then
// merged here into one globally-ordered page. A non-GLOBAL actor with
// zero relevant grants gets an empty page without any Firestore read at
// all.
export async function listLeadDocs(options: LeadListQueryOptions & { limit: number; cursor?: LeadListCursor }): Promise<ListLeadsPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_LEAD_PAGE_SIZE));
  const { plan, orderField, orderDirection } = planLeadListQuery(options);
  assertProductionValidPlan(plan);
  if (plan.branches.length === 0) return { leads: [], nextCursor: null };

  const collection = leadsCollection();
  const cursorIn = options.cursor ?? {};
  const branchBatches: Array<{ name: string; items: MergeCandidate<LeadDoc>[] }> = [];
  const nextCursorBuilders: Array<(consumed: number) => [string, BranchCursorState] | null> = [];

  for (const branch of plan.branches) {
    if (branch.kind === "bounded-ids") {
      const previous = cursorIn[branch.name];
      if (previous && "exhausted" in previous) continue;
      const previousIndex = previous && "index" in previous ? previous.index : 0;

      const rawDocs = await executeBoundedIdsBranch(collection, branch);
      const survivors: MergeCandidate<LeadDoc>[] = [];
      for (const doc of rawDocs) {
        const data = doc.data();
        if (!passesBranchPostFilters(data, branch)) continue;
        const parsed = leadDocSchema.safeParse(data);
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
    const survivors: MergeCandidate<LeadDoc>[] = [];
    rawDocs.forEach((doc, rawIndex) => {
      const data = doc.data();
      if (!passesBranchPostFilters(data, branch)) return;
      const parsed = leadDocSchema.safeParse(data);
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

  return { leads: page, nextCursor: page.length === pageSize && anyResumable ? nextCursor : null };
}
