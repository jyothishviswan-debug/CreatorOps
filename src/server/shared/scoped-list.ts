import { FieldPath, Filter } from "firebase-admin/firestore";
import { z } from "zod";

// Step 8A.2: the shared query-planning/execution/merge primitives behind
// every scoped, cursor-paginated list query in this app (Discovery's
// listLeadDocs, Partners' listPartnerDocs, Vendors' listVendorDocs).
//
// Why this exists: the pre-8A.2 design pushed every scope dimension
// (SELF/REGION/TEAM/EXPLICIT_RECORD) into ONE Firestore query via
// Filter.or(...), then AND'd extra filters on top. Two shapes that
// design can produce are not production-valid Firestore queries at all:
//   1. `where(documentId(), "in", ids)` combined with a different
//      orderBy field - Firestore cannot index this combination.
//   2. two array-type filters (array-contains / array-contains-any) in
//      one query, which happens the moment a REGION-scoped actor's
//      array-contains-any branch is AND'd with an operator-selected
//      "region" filter's own array-contains, or a TEAM branch's
//      array-contains-any is AND'd with that same region filter.
//
// The fix: never OR scope dimensions into one query. Decompose scope
// into independent branches (one Firestore query - or one small bounded
// "fetch by id" read for EXPLICIT_RECORD - per dimension), each
// independently valid by construction (assertProductionValidPlan makes
// this a runtime guarantee, not just a design intention), each
// cursor-paginated on its own, and merge their pages server-side with a
// compound cursor. Branches are made mutually exclusive by excluding any
// document a higher-priority branch would already surface (SELF > REGION
// > TEAM > EXPLICIT_RECORD), so the merge never needs cross-page
// deduplication bookkeeping - a document can only ever come from exactly
// one branch.
//
// Kept deliberately narrow: this is a mechanical filter/merge helper for
// the specific "equality/array/range filters + one order field + docId
// tie-break, paginated" query shape every list query here already uses -
// never a generic query builder for arbitrary app logic.

// Normalizes a caller-supplied single-or-multi-value filter (e.g. a
// multi-select region filter) into a plain array - `undefined` becomes
// `[]`, a bare string becomes a one-element array. Shared by every
// domain's planner (Discovery/Partners/Vendors/Campaigns) so a multi-
// select filter's `array-contains-any` construction is written the same
// way everywhere.
export function toValueArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export type FirestoreFieldFilter =
  | { field: string; op: "=="; value: unknown }
  | { field: string; op: "array-contains"; value: unknown }
  | { field: string; op: "array-contains-any"; value: unknown[] }
  | { field: string; op: "in"; value: unknown[] }
  | { field: string; op: ">=" | "<=" | "<"; value: string };

export type SortDirection = "asc" | "desc";

// A branch backed by a real, independently-paginated Firestore query.
// `pushedFilters` are sent to Firestore as-is (mechanically translated -
// see executeFirestoreBranch); `postFilters` are evaluated in-memory
// against each fetched doc afterward (for a condition that can't be
// safely combined with the others in one Firestore query, e.g. a second
// array-type filter).
// `excludePostFilters`: a doc matching ANY of these is dropped, in-memory,
// after fetch - how lower-priority branches stay disjoint from
// higher-priority ones (e.g. a "region" branch excludes anything the
// "self" branch would already surface) without needing a Firestore-side
// `!=`/`not-in` (which carries its own combination restrictions and
// would just reintroduce the same class of problem this module exists
// to avoid).
export type FirestoreListBranchPlan = {
  kind: "firestore-query";
  name: string;
  pushedFilters: FirestoreFieldFilter[];
  postFilters: FirestoreFieldFilter[];
  excludePostFilters: FirestoreFieldFilter[];
  orderField: string;
  orderDirection: SortDirection;
};

// A branch backed by a small, bounded "fetch these exact document ids"
// read (documentId() "in" [...], Firestore's 30-value cap) - never
// combined with an orderBy in the same Firestore call. All filtering and
// sorting for this branch happens in-memory, over its own bounded set.
export type BoundedIdsBranchPlan = {
  kind: "bounded-ids";
  name: string;
  ids: string[];
  postFilters: FirestoreFieldFilter[];
  excludePostFilters: FirestoreFieldFilter[];
};

export type ListBranchPlan = FirestoreListBranchPlan | BoundedIdsBranchPlan;
export type ListQueryPlan = { branches: ListBranchPlan[] };

export class InvalidListQueryPlanError extends Error {}

// Makes the two production-invalid shapes impossible by construction:
// called by every list*Docs function immediately after planning, before
// any Firestore read - a violation here is a bug in the planner itself,
// never a legitimate runtime state, so it throws rather than degrading.
export function assertProductionValidPlan(plan: ListQueryPlan): void {
  for (const branch of plan.branches) {
    if (branch.kind !== "firestore-query") continue;

    const arrayFilters = branch.pushedFilters.filter((f) => f.op === "array-contains" || f.op === "array-contains-any");
    if (arrayFilters.length > 1) {
      throw new InvalidListQueryPlanError(
        `Branch "${branch.name}" pushes ${arrayFilters.length} array-type filters (array-contains/array-contains-any) into one Firestore query - only one is ever supported. Move the extra condition to postFilters instead.`,
      );
    }

    const documentIdIn = branch.pushedFilters.some((f) => f.op === "in" && f.field === "__name__");
    if (documentIdIn) {
      throw new InvalidListQueryPlanError(`Branch "${branch.name}" pushes documentId() "in" into a firestore-query branch with an orderBy - use a bounded-ids branch instead.`);
    }
  }
}

function readFieldPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

// The in-memory counterpart of a Firestore filter - used to evaluate
// postFilters (and, for bounded-ids branches, every filter) against an
// already-fetched doc's own data.
export function matchesFilter(data: Record<string, unknown>, filter: FirestoreFieldFilter): boolean {
  const value = readFieldPath(data, filter.field);
  switch (filter.op) {
    case "==":
      return value === filter.value;
    case ">=":
      return typeof value === "string" && value >= filter.value;
    case "<=":
      return typeof value === "string" && value <= filter.value;
    case "<":
      return typeof value === "string" && value < filter.value;
    case "in":
      return filter.value.includes(value);
    case "array-contains":
      return Array.isArray(value) && value.includes(filter.value);
    case "array-contains-any":
      return Array.isArray(value) && value.some((v) => filter.value.includes(v));
  }
}

export function matchesAllFilters(data: Record<string, unknown>, filters: FirestoreFieldFilter[]): boolean {
  return filters.every((f) => matchesFilter(data, f));
}

// True when `data` survives a branch's full in-memory contract: every
// postFilter matched, and no excludePostFilter matched.
export function passesBranchPostFilters(data: Record<string, unknown>, branch: Pick<FirestoreListBranchPlan | BoundedIdsBranchPlan, "postFilters" | "excludePostFilters">): boolean {
  return matchesAllFilters(data, branch.postFilters) && !branch.excludePostFilters.some((f) => matchesFilter(data, f));
}

function toFirestoreFilter(filter: FirestoreFieldFilter): Filter {
  const field = filter.field === "__name__" ? FieldPath.documentId() : filter.field;
  return Filter.where(field, filter.op, filter.value);
}

export type BranchQueryCursor = { orderValue: string; uid: string };

// Executes one firestore-query branch, bounded to pageSize+1 (the
// standard "fetch one extra to know if there's more" idiom every list
// query in this codebase already uses), starting after its own saved
// per-branch cursor.
export async function executeFirestoreBranch(
  collectionRef: FirebaseFirestore.CollectionReference,
  branch: FirestoreListBranchPlan,
  cursor: BranchQueryCursor | undefined,
  pageSize: number,
): Promise<{ docs: FirebaseFirestore.QueryDocumentSnapshot[]; hasMoreInBranch: boolean }> {
  let query: FirebaseFirestore.Query = collectionRef.orderBy(branch.orderField, branch.orderDirection).orderBy(FieldPath.documentId()).limit(pageSize + 1);

  const firestoreFilters = branch.pushedFilters.map(toFirestoreFilter);
  if (firestoreFilters.length === 1) query = query.where(firestoreFilters[0]!);
  else if (firestoreFilters.length > 1) query = query.where(Filter.and(...firestoreFilters));

  if (cursor) query = query.startAfter(cursor.orderValue, cursor.uid);

  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, pageSize);
  return { docs, hasMoreInBranch: snapshot.docs.length > pageSize };
}

// Executes a bounded-ids branch: fetches all named ids in one call (no
// orderBy, no limit - the 30-id cap already bounds it), no pagination of
// its own. Every subsequent page request re-fetches the same bounded
// set; a stable in-memory sort + index-based cursor (see
// mergeListBranches) is what makes pagination over it deterministic.
export async function executeBoundedIdsBranch(collectionRef: FirebaseFirestore.CollectionReference, branch: BoundedIdsBranchPlan): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  if (branch.ids.length === 0) return [];
  const snapshot = await collectionRef.where(FieldPath.documentId(), "in", branch.ids).get();
  return snapshot.docs;
}

// ---- Merge ---------------------------------------------------------------

export type MergeCandidate<T> = { doc: T; sortValue: string; uid: string };

export type BranchCursorState = { orderValue: string; uid: string } | { index: number } | { exhausted: true };

// Opaque to every caller above the planner/executor - echoed back
// unchanged as the page's `nextCursor` and decoded on the next request.
// One entry per branch name; a branch absent from a given request's plan
// simply has no entry, and a branch present in the plan but not yet
// resumable (its cursor state is still "not started") is likewise
// simply absent as a key here - there is no sentinel value for that
// state, since a synthetic empty-string sentinel would risk being
// treated as a real (and, for descending order, unreachable) cursor
// position by Firestore's own startAfter(). Typed as a plain (not
// Partial<>) Record so it round-trips cleanly through zod's inferred
// input/output types; every read site still treats a missing key as
// "not started" defensively rather than assuming presence.
export type CompoundListCursor = Record<string, BranchCursorState>;

// Untrusted-input validation for a cursor a caller echoes back over
// HTTP - one domain-shared schema, since the shape is identical across
// Discovery/Partners/Vendors. A malformed/tampered cursor simply fails
// validation the same way an old-shape cursor would have (400, not a
// crash) - never trusted to skip the branch-name allowlist a domain's
// own planner would produce.
const branchCursorStateSchema = z.union([z.object({ orderValue: z.string(), uid: z.string().min(1) }), z.object({ index: z.number().int().min(0) }), z.object({ exhausted: z.literal(true) })]);
export const compoundListCursorSchema = z.record(z.string(), branchCursorStateSchema);

export type FirestoreBranchFetchResult = { rawDocs: Array<{ orderValue: string; uid: string }>; hasMoreInBranch: boolean };

// Computes a firestore-query branch's next cursor, given how many of its
// already-postFilter-survived candidates (in original fetch order) the
// merge actually consumed this round. A rejected (postFilter-failed) raw
// doc is always safe to permanently skip past; an unconsumed SURVIVOR
// must never be skipped past, since it still needs reconsidering on a
// later page - so the cursor only ever advances up to the position just
// before the first unconsumed survivor (or, when every survivor in this
// batch was consumed, up to the last raw doc fetched).
export function nextFirestoreBranchCursor(params: {
  fetch: FirestoreBranchFetchResult;
  survivorRawIndexes: number[];
  consumed: number;
  previousCursor: BranchCursorState | undefined;
}): BranchCursorState | undefined {
  const { fetch, survivorRawIndexes, consumed, previousCursor } = params;

  if (consumed < survivorRawIndexes.length) {
    const nextRawIndex = survivorRawIndexes[consumed]!;
    if (nextRawIndex === 0) return previousCursor; // nothing safely skippable yet - unchanged
    const safeDoc = fetch.rawDocs[nextRawIndex - 1]!;
    return { orderValue: safeDoc.orderValue, uid: safeDoc.uid };
  }

  if (fetch.hasMoreInBranch) {
    const lastDoc = fetch.rawDocs[fetch.rawDocs.length - 1]!;
    return { orderValue: lastDoc.orderValue, uid: lastDoc.uid };
  }

  return { exhausted: true };
}

// The bounded-ids branch equivalent - trivial by comparison, since its
// full candidate set is re-fetched and re-filtered in full (bounded to
// Firestore's 30-value "in" cap) on every request: the cursor is just
// how many of the stable, deterministically-sorted survivors have
// already been emitted.
export function nextBoundedIdsBranchCursor(previousIndex: number, consumed: number, totalSurvivors: number): BranchCursorState {
  const nextIndex = previousIndex + consumed;
  return nextIndex >= totalSurvivors ? { exhausted: true } : { index: nextIndex };
}

function compareCandidates(a: { sortValue: string; uid: string }, b: { sortValue: string; uid: string }, direction: SortDirection): number {
  if (a.sortValue !== b.sortValue) {
    const cmp = a.sortValue < b.sortValue ? -1 : 1;
    return direction === "asc" ? cmp : -cmp;
  }
  return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}

// Merges the current page's already-fetched, already-sorted batch from
// each branch into one globally-ordered page of at most `pageSize`
// items. Branches are assumed disjoint (a document can only appear in
// one branch's batch - see each domain's exclusion predicates), so no
// cross-branch de-duplication happens here; this is a pure k-way merge
// over small, pre-fetched, pre-sorted arrays.
export function mergeListBranches<T>(branchBatches: Array<{ name: string; items: MergeCandidate<T>[] }>, pageSize: number, direction: SortDirection): { page: T[]; consumed: Record<string, number> } {
  const pointers: Record<string, number> = {};
  for (const b of branchBatches) pointers[b.name] = 0;

  const page: T[] = [];
  while (page.length < pageSize) {
    let bestName: string | null = null;
    let best: MergeCandidate<T> | null = null;
    for (const b of branchBatches) {
      const idx = pointers[b.name]!;
      if (idx >= b.items.length) continue;
      const candidate = b.items[idx]!;
      if (!best || compareCandidates(candidate, best, direction) < 0) {
        best = candidate;
        bestName = b.name;
      }
    }
    if (!bestName || !best) break;
    page.push(best.doc);
    pointers[bestName] += 1;
  }

  return { page, consumed: pointers };
}
