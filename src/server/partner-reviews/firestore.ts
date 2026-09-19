import { getAdminFirestore } from "@/server/firebase/admin";
import type { ScopeGrant } from "@/server/authz/types";
import {
  assertProductionValidPlan,
  executeFirestoreBranch,
  mergeListBranches,
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
import { partnerReviewHeadDocSchema, partnerReviewVersionDocSchema, type PartnerReviewHeadDoc, type PartnerReviewVersionDoc } from "./types";

export const PARTNER_REVIEWS_COLLECTIONS = {
  partnerReviews: "partnerReviews",
  versions: "versions", // subcollection name under partnerReviews/{reviewRef}
  events: "events", // subcollection name under partnerReviews/{reviewRef}
} as const;

export const MAX_PARTNER_REVIEW_PAGE_SIZE = 100;
export const DEFAULT_PARTNER_REVIEW_PAGE_SIZE = 20;
// Version summaries returned with one review detail (newest first).
export const MAX_VERSION_SUMMARIES = 50;

// Firestore's `in` operator caps at 30 values per query.
const MAX_SCOPE_IN_VALUES = 30;

export function partnerReviewsCollection() {
  return getAdminFirestore().collection(PARTNER_REVIEWS_COLLECTIONS.partnerReviews);
}

export function partnerReviewVersionsCollection(reviewRef: string) {
  return partnerReviewsCollection().doc(reviewRef).collection(PARTNER_REVIEWS_COLLECTIONS.versions);
}

export function partnerReviewEventsCollection(reviewRef: string) {
  return partnerReviewsCollection().doc(reviewRef).collection(PARTNER_REVIEWS_COLLECTIONS.events);
}

// Version doc ids are the plain integer as a string ("1", "2", ...) - the
// deterministic id makes "exactly one version N" a document-existence
// fact. Ordering never relies on the id (it would sort "10" before "2");
// list order is always the numeric `version` field.
export function versionDocId(version: number): string {
  return String(version);
}

export async function getPartnerReviewHeadDoc(reviewRef: string): Promise<PartnerReviewHeadDoc | null> {
  const snapshot = await partnerReviewsCollection().doc(reviewRef).get();
  if (!snapshot.exists) return null;
  const result = partnerReviewHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getPartnerReviewVersionDoc(reviewRef: string, version: number): Promise<PartnerReviewVersionDoc | null> {
  const snapshot = await partnerReviewVersionsCollection(reviewRef).doc(versionDocId(version)).get();
  if (!snapshot.exists) return null;
  const result = partnerReviewVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Bounded, newest-first list of one review's versions (by the numeric
// `version` field - a single-field index).
export async function listPartnerReviewVersionDocs(reviewRef: string, limit = MAX_VERSION_SUMMARIES): Promise<{ versions: PartnerReviewVersionDoc[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_VERSION_SUMMARIES));
  const snapshot = await partnerReviewVersionsCollection(reviewRef)
    .orderBy("version", "desc")
    .limit(bound + 1)
    .get();

  const versions: PartnerReviewVersionDoc[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = partnerReviewVersionDocSchema.safeParse(doc.data());
    if (parsed.success) versions.push(parsed.data);
  }
  return { versions, hasMore: snapshot.docs.length > bound };
}

// --- Scoped head list ---------------------------------------------------------
export type PartnerReviewListCursor = CompoundListCursor;
export type ListPartnerReviewHeadsPage = { heads: PartnerReviewHeadDoc[]; nextCursor: PartnerReviewListCursor | null };

function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

export type PartnerReviewListQueryOptions = {
  actorUid: string;
  grants: ScopeGrant[];
  hasGlobal: boolean;
  // When set, the CALLER has already authorized the Partner (live Partner
  // Record Scope) and this single Partner's heads are listed directly,
  // bypassing the head-snapshot scope branches entirely.
  partnerRef?: string;
  partnerAuthorized?: boolean;
  periodKey?: string;
  // Filter on the status of the newest version (latestStatus). Applied in
  // memory - it needs no index, at the cost of at most an extra page turn
  // (same trade-off every domain's own post-filters already accept).
  status?: string;
};

// Pure query planner - builds the branch plan only, never touches
// Firestore. Exported for unit tests and the index certification test.
//
// Order is (periodKey desc, document id) - newest review period first.
// Scope is decomposed into independent, individually production-valid
// branches (SELF via ownerUid, REGION/TEAM via array-contains-any, and
// PARTNER/EXPLICIT_RECORD partner grants via `partnerUid in [...]`), each
// paginated on its own and merged; lower-priority branches exclude what a
// higher-priority one already surfaces. A `periodKey` filter is pushed as
// a range on the order field itself (>= X and <= X), the canonical valid
// shape that never adds a leading index field.
export function planPartnerReviewListQuery(options: PartnerReviewListQueryOptions): { plan: ListQueryPlan; orderField: string; orderDirection: SortDirection } {
  const orderField = "periodKey";
  const orderDirection: SortDirection = "desc";

  const sharedFilters: FirestoreFieldFilter[] = [];
  if (options.periodKey) {
    sharedFilters.push({ field: "periodKey", op: ">=", value: options.periodKey });
    sharedFilters.push({ field: "periodKey", op: "<=", value: options.periodKey });
  }
  const statusPostFilters: FirestoreFieldFilter[] = options.status ? [{ field: "latestStatus", op: "==", value: options.status }] : [];

  const branches: ListBranchPlan[] = [];

  if (options.partnerRef && options.partnerAuthorized) {
    branches.push({
      kind: "firestore-query",
      name: "partner",
      pushedFilters: [{ field: "partnerRef", op: "==", value: options.partnerRef }, ...sharedFilters],
      postFilters: statusPostFilters,
      excludePostFilters: [],
      orderField,
      orderDirection,
    });
    return { plan: { branches }, orderField, orderDirection };
  }

  const partnerRefPost: FirestoreFieldFilter[] = options.partnerRef ? [{ field: "partnerRef", op: "==", value: options.partnerRef }] : [];

  if (options.hasGlobal) {
    branches.push({
      kind: "firestore-query",
      name: "main",
      pushedFilters: sharedFilters,
      postFilters: [...partnerRefPost, ...statusPostFilters],
      excludePostFilters: [],
      orderField,
      orderDirection,
    });
    return { plan: { branches }, orderField, orderDirection };
  }

  const selfGranted = options.grants.some((g) => g.type === "SELF");
  const grantedRegions = [...new Set(options.grants.filter((g): g is Extract<ScopeGrant, { type: "REGION" }> => g.type === "REGION").map((g) => g.region))].slice(0, MAX_SCOPE_IN_VALUES);
  const grantedTeams = [...new Set(options.grants.filter((g): g is Extract<ScopeGrant, { type: "TEAM" }> => g.type === "TEAM").map((g) => g.teamId))].slice(0, MAX_SCOPE_IN_VALUES);
  // PARTNER grants name a Partner uid; EXPLICIT_RECORD grants with
  // resourceType "partner" do too (both are honored by requirePartnerInScope).
  const grantedPartnerUids = [
    ...new Set([
      ...options.grants.filter((g): g is Extract<ScopeGrant, { type: "PARTNER" }> => g.type === "PARTNER").map((g) => g.partnerId),
      ...options.grants.filter((g): g is Extract<ScopeGrant, { type: "EXPLICIT_RECORD" }> => g.type === "EXPLICIT_RECORD" && g.resourceType === "partner").map((g) => g.resourceId),
    ]),
  ].slice(0, MAX_SCOPE_IN_VALUES);

  const selfExclude: FirestoreFieldFilter = { field: "ownerUid", op: "==", value: options.actorUid };
  const regionExclude: FirestoreFieldFilter | null = grantedRegions.length > 0 ? { field: "regionIds", op: "array-contains-any", value: grantedRegions } : null;
  const teamExclude: FirestoreFieldFilter | null = grantedTeams.length > 0 ? { field: "teamIds", op: "array-contains-any", value: grantedTeams } : null;

  const extraPost = [...partnerRefPost, ...statusPostFilters];

  if (selfGranted) {
    branches.push({ kind: "firestore-query", name: "self", pushedFilters: [selfExclude, ...sharedFilters], postFilters: extraPost, excludePostFilters: [], orderField, orderDirection });
  }
  if (regionExclude) {
    branches.push({
      kind: "firestore-query",
      name: "region",
      pushedFilters: [regionExclude, ...sharedFilters],
      postFilters: extraPost,
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
      postFilters: extraPost,
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(regionExclude ? [regionExclude] : [])],
      orderField,
      orderDirection,
    });
  }
  if (grantedPartnerUids.length > 0) {
    branches.push({
      kind: "firestore-query",
      name: "partnerGrant",
      pushedFilters: [{ field: "partnerUid", op: "in", value: grantedPartnerUids }, ...sharedFilters],
      postFilters: extraPost,
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(regionExclude ? [regionExclude] : []), ...(teamExclude ? [teamExclude] : [])],
      orderField,
      orderDirection,
    });
  }

  return { plan: { branches }, orderField, orderDirection };
}

// Bounded cursor pagination, scope-constrained BEFORE retrieval - never a
// fetch-all followed by in-memory filtering. Mirrors listAssignmentDocs.
export async function listPartnerReviewHeadDocs(options: PartnerReviewListQueryOptions & { limit: number; cursor?: PartnerReviewListCursor }): Promise<ListPartnerReviewHeadsPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_PARTNER_REVIEW_PAGE_SIZE));
  const { plan, orderField, orderDirection } = planPartnerReviewListQuery(options);
  assertProductionValidPlan(plan);
  if (plan.branches.length === 0) return { heads: [], nextCursor: null };

  const collection = partnerReviewsCollection();
  const cursorIn = options.cursor ?? {};
  const branchBatches: Array<{ name: string; items: MergeCandidate<PartnerReviewHeadDoc>[] }> = [];
  const nextCursorBuilders: Array<(consumed: number) => [string, BranchCursorState] | null> = [];

  for (const branch of plan.branches) {
    if (branch.kind !== "firestore-query") continue;

    const previous = cursorIn[branch.name];
    if (previous && "exhausted" in previous) continue;
    const queryCursor = previous && "orderValue" in previous ? previous : undefined;

    const { docs: rawDocs, hasMoreInBranch } = await executeFirestoreBranch(collection, branch, queryCursor, pageSize);
    const survivorRawIndexes: number[] = [];
    const survivors: MergeCandidate<PartnerReviewHeadDoc>[] = [];
    rawDocs.forEach((doc, rawIndex) => {
      const data = doc.data();
      if (!passesBranchPostFilters(data, branch)) return;
      const parsed = partnerReviewHeadDocSchema.safeParse(data);
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

  return { heads: page, nextCursor: page.length === pageSize && anyResumable ? nextCursor : null };
}
