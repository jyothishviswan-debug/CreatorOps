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
import { campaignDocSchema, type CampaignDoc } from "./types";

export const CAMPAIGNS_COLLECTIONS = {
  campaigns: "campaigns",
  campaignEvents: "events", // subcollection name under campaigns/{uid}
} as const;

export const MAX_CAMPAIGN_PAGE_SIZE = 100;
export const DEFAULT_CAMPAIGN_PAGE_SIZE = 20;

// Firestore's `in` operator caps at 30 values per query - same bounded
// discipline as Discovery's/Partners'/Vendors' own firestore.ts.
const MAX_SCOPE_IN_VALUES = 30;

export function campaignsCollection() {
  return getAdminFirestore().collection(CAMPAIGNS_COLLECTIONS.campaigns);
}

export function campaignEventsCollection(campaignUid: string) {
  return campaignsCollection().doc(campaignUid).collection(CAMPAIGNS_COLLECTIONS.campaignEvents);
}

export async function getCampaignDocByUid(uid: string): Promise<CampaignDoc | null> {
  const snapshot = await campaignsCollection().doc(uid).get();
  if (!snapshot.exists) return null;
  const result = campaignDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Resolves a Campaign by its opaque, browser-facing campaignRef instead of
// the internal Firestore doc id - same idiom as getVendorDocByRef. A
// tampered or made-up token simply matches no document (never leaks
// whether a differently-scoped Campaign exists).
export async function getCampaignDocByRef(campaignRef: string): Promise<CampaignDoc | null> {
  const snapshot = await campaignsCollection().where("campaignRef", "==", campaignRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = campaignDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export type CampaignMutationResult = { kind: "ok"; doc: CampaignDoc } | { kind: "stale" } | { kind: "not_found" };

// Shared transactional "read current, verify optimistic version, apply a
// pure patch, write" primitive - same discipline as Vendors' own
// runVendorMutation. Used by every ordinary Campaign field mutation;
// lifecycle transitions (which need extra preconditions) run their own
// transaction instead (see campaign-lifecycle-service.ts).
export async function runCampaignMutation(campaignUid: string, expectedVersion: number, mutate: (current: CampaignDoc) => CampaignDoc): Promise<CampaignMutationResult> {
  const db = getAdminFirestore();
  const docRef = campaignsCollection().doc(campaignUid);

  return db.runTransaction<CampaignMutationResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsed = campaignDocSchema.safeParse(snap.data());
    if (!parsed.success) return { kind: "not_found" };
    const current = parsed.data;

    if (current.version !== expectedVersion) return { kind: "stale" };

    const next = { ...mutate(current), version: current.version + 1 };
    tx.set(docRef, next);
    return { kind: "ok", doc: next };
  });
}

// Opaque to callers - one entry per active branch (see
// planCampaignListQuery), keyed by branch name. Echoed back unchanged.
export type CampaignListCursor = CompoundListCursor;
export type ListCampaignsPage = { campaigns: CampaignDoc[]; nextCursor: CampaignListCursor | null };

function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

export type CampaignListQueryOptions = {
  actorUid: string;
  grants: ScopeGrant[];
  hasGlobal: boolean;
  status?: string;
  namePrefix?: string;
  region?: string | string[];
  platform?: string;
  ownerUid?: string;
};

// Step 9A: pure query planner - builds the branch plan only, never
// touches Firestore. Exported for unit tests. Mirrors Vendors' own
// planVendorListQuery, extended with a SECOND business array filter
// (platform, on top of the operator-selected region filter Vendors
// already supports) and a combined CAMPAIGN+EXPLICIT_RECORD bounded-ids
// branch (Campaign is the one domain with its own dedicated CAMPAIGN
// scope-grant type - see @/server/authz/scope.ts's isCampaignInScope -
// merged with EXPLICIT_RECORD's resourceType:"campaign" grants into one
// branch since both mechanisms are mechanically identical, "grant access
// to this exact document id").
//
// Array-filter budget discipline (Step 8A.2's own rule: at most ONE
// array-type filter per Firestore query): "self"/"main" branches start
// with zero array filters, so they may carry ONE operator-selected
// business array filter (region is preferred when both are supplied,
// platform falls back to a postFilter) as a real pushed filter; "region"/
// "team" branches already spend their one slot on their own scope-
// exclusion filter, so BOTH operator filters land in postFilters there.
export function planCampaignListQuery(options: CampaignListQueryOptions): { plan: ListQueryPlan; orderField: string; orderDirection: SortDirection } {
  const sharedFilters: FirestoreFieldFilter[] = [];
  if (options.status) sharedFilters.push({ field: "status", op: "==", value: options.status });
  if (options.ownerUid) sharedFilters.push({ field: "ownerUid", op: "==", value: options.ownerUid });

  let orderField = "createdAt";
  let orderDirection: SortDirection = "desc";
  if (options.namePrefix) {
    orderField = "nameLower";
    orderDirection = "asc";
    sharedFilters.push({ field: "nameLower", op: ">=", value: options.namePrefix });
    sharedFilters.push({ field: "nameLower", op: "<", value: `${options.namePrefix}` });
  }

  const requestedRegions = toValueArray(options.region);
  const regionFilter: FirestoreFieldFilter | null = requestedRegions.length > 0 ? { field: "regionIds", op: "array-contains-any", value: requestedRegions } : null;
  const platformFilter: FirestoreFieldFilter | null = options.platform ? { field: "platforms", op: "array-contains", value: options.platform } : null;
  // At most one of these may be PUSHED into any single branch alongside
  // that branch's own array filter (if any) - region wins the pushed
  // slot when both are supplied; platform always falls back to a
  // postFilter in that case (still fully correct, just evaluated
  // in-memory instead of server-side).
  const pushableBusinessFilter = regionFilter ?? platformFilter;
  const leftoverBusinessFilter = regionFilter && platformFilter ? platformFilter : null;

  const branches: ListBranchPlan[] = [];

  const explicitCampaignUids = [
    ...new Set([
      ...options.grants.filter((g): g is Extract<ScopeGrant, { type: "CAMPAIGN" }> => g.type === "CAMPAIGN").map((g) => g.campaignId),
      ...options.grants.filter((g): g is Extract<ScopeGrant, { type: "EXPLICIT_RECORD" }> => g.type === "EXPLICIT_RECORD" && g.resourceType === "campaign").map((g) => g.resourceId),
    ]),
  ].slice(0, MAX_SCOPE_IN_VALUES);

  if (options.hasGlobal) {
    branches.push({
      kind: "firestore-query",
      name: "main",
      pushedFilters: [...sharedFilters, ...(pushableBusinessFilter ? [pushableBusinessFilter] : [])],
      postFilters: leftoverBusinessFilter ? [leftoverBusinessFilter] : [],
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
    branches.push({
      kind: "firestore-query",
      name: "main",
      pushedFilters: [...sharedFilters, regionFilter!],
      postFilters: platformFilter ? [platformFilter] : [],
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
    branches.push({
      kind: "firestore-query",
      name: "self",
      pushedFilters: [selfExclude, ...sharedFilters, ...(pushableBusinessFilter ? [pushableBusinessFilter] : [])],
      postFilters: leftoverBusinessFilter ? [leftoverBusinessFilter] : [],
      excludePostFilters: [],
      orderField,
      orderDirection,
    });
  }

  if (requestedRegions.length === 0 && regionExclude) {
    branches.push({
      kind: "firestore-query",
      name: "region",
      pushedFilters: [regionExclude, ...sharedFilters],
      postFilters: platformFilter ? [platformFilter] : [],
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
      postFilters: [...(requestedRegions.length > 0 ? [regionFilter!] : []), ...(platformFilter ? [platformFilter] : [])],
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(requestedRegions.length === 0 && regionExclude ? [regionExclude] : [])],
      orderField,
      orderDirection,
    });
  }

  if (explicitCampaignUids.length > 0) {
    branches.push({
      kind: "bounded-ids",
      name: "explicit",
      ids: explicitCampaignUids,
      postFilters: [...sharedFilters, ...(regionFilter ? [regionFilter] : []), ...(platformFilter ? [platformFilter] : [])],
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(regionExclude ? [regionExclude] : []), ...(teamExclude ? [teamExclude] : [])],
    });
  }

  return { plan: { branches }, orderField, orderDirection };
}

// Bounded cursor pagination, scope-constrained BEFORE retrieval - never a
// browser or server fetch-all followed by in-memory filtering. Mirrors
// Vendors' listVendorDocs exactly - see planCampaignListQuery's own
// comment for the branch-decomposition rationale.
export async function listCampaignDocs(options: CampaignListQueryOptions & { limit: number; cursor?: CampaignListCursor }): Promise<ListCampaignsPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_CAMPAIGN_PAGE_SIZE));
  const { plan, orderField, orderDirection } = planCampaignListQuery(options);
  assertProductionValidPlan(plan);
  if (plan.branches.length === 0) return { campaigns: [], nextCursor: null };

  const collection = campaignsCollection();
  const cursorIn = options.cursor ?? {};
  const branchBatches: Array<{ name: string; items: MergeCandidate<CampaignDoc>[] }> = [];
  const nextCursorBuilders: Array<(consumed: number) => [string, BranchCursorState] | null> = [];

  for (const branch of plan.branches) {
    if (branch.kind === "bounded-ids") {
      const previous = cursorIn[branch.name];
      if (previous && "exhausted" in previous) continue;
      const previousIndex = previous && "index" in previous ? previous.index : 0;

      const rawDocs = await executeBoundedIdsBranch(collection, branch);
      const survivors: MergeCandidate<CampaignDoc>[] = [];
      for (const doc of rawDocs) {
        const data = doc.data();
        if (!passesBranchPostFilters(data, branch)) continue;
        const parsed = campaignDocSchema.safeParse(data);
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
    const survivors: MergeCandidate<CampaignDoc>[] = [];
    rawDocs.forEach((doc, rawIndex) => {
      const data = doc.data();
      if (!passesBranchPostFilters(data, branch)) return;
      const parsed = campaignDocSchema.safeParse(data);
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

  return { campaigns: page, nextCursor: page.length === pageSize && anyResumable ? nextCursor : null };
}
