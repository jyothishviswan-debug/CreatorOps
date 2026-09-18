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
import { assignmentActiveClaimDocSchema, assignmentDocSchema, type AssignmentActiveClaimDoc, type AssignmentDoc } from "./types";
import { assignmentSubmissionSessionDocSchema, type AssignmentSubmissionSessionDoc } from "./external-submission-types";

export const ASSIGNMENTS_COLLECTIONS = {
  assignments: "assignments",
  assignmentEvents: "events", // subcollection name under assignments/{uid}
  assignmentActiveClaims: "assignmentActiveClaims",
  assignmentSubmissionSessions: "assignmentSubmissionSessions",
  assignmentExternalSubmissions: "assignmentExternalSubmissions",
} as const;

export const MAX_ASSIGNMENT_PAGE_SIZE = 100;
export const DEFAULT_ASSIGNMENT_PAGE_SIZE = 20;

// Firestore's `in` operator caps at 30 values per query - same bounded
// discipline as every other domain's firestore.ts.
const MAX_SCOPE_IN_VALUES = 30;

export function assignmentsCollection() {
  return getAdminFirestore().collection(ASSIGNMENTS_COLLECTIONS.assignments);
}

export function assignmentEventsCollection(assignmentUid: string) {
  return assignmentsCollection().doc(assignmentUid).collection(ASSIGNMENTS_COLLECTIONS.assignmentEvents);
}

// The one-canonical-Assignment-per-(campaignRef, partnerRef) claim
// collection - see types.ts's own comment on assignmentActiveClaimDocSchema.
export function assignmentActiveClaimsCollection() {
  return getAdminFirestore().collection(ASSIGNMENTS_COLLECTIONS.assignmentActiveClaims);
}

export function assignmentSubmissionSessionsCollection() {
  return getAdminFirestore().collection(ASSIGNMENTS_COLLECTIONS.assignmentSubmissionSessions);
}

export function assignmentExternalSubmissionsCollection() {
  return getAdminFirestore().collection(ASSIGNMENTS_COLLECTIONS.assignmentExternalSubmissions);
}

// Deterministic composite doc id for the uniqueness claim - `:` separator
// matches the repo's existing "deterministic id from derived values"
// idiom (e.g. restrictedFinancialIdentities' `${SUBJECTTYPE}:${uid}`).
// Neither campaignRef nor partnerRef ever contains `:` (both are
// randomUUID-generated opaque refs), so this is always unambiguous.
export function assignmentActiveClaimDocId(campaignRef: string, partnerRef: string): string {
  return `${campaignRef}:${partnerRef}`;
}

export async function getAssignmentDocByUid(uid: string): Promise<AssignmentDoc | null> {
  const snapshot = await assignmentsCollection().doc(uid).get();
  if (!snapshot.exists) return null;
  const result = assignmentDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Resolves an Assignment by its opaque, browser-facing assignmentRef
// instead of the internal Firestore doc id - same idiom as
// getCampaignDocByRef. A tampered or made-up token simply matches no
// document (never leaks whether a differently-scoped Assignment exists).
export async function getAssignmentDocByRef(assignmentRef: string): Promise<AssignmentDoc | null> {
  const snapshot = await assignmentsCollection().where("assignmentRef", "==", assignmentRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = assignmentDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export async function getAssignmentActiveClaim(campaignRef: string, partnerRef: string): Promise<AssignmentActiveClaimDoc | null> {
  const snapshot = await assignmentActiveClaimsCollection().doc(assignmentActiveClaimDocId(campaignRef, partnerRef)).get();
  if (!snapshot.exists) return null;
  const result = assignmentActiveClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// The external-submission session's staff-facing lookup (by its opaque
// sessionRef, never its doc id/tokenHash - see external-submission-types.ts).
export async function getSubmissionSessionDocByRef(sessionRef: string): Promise<AssignmentSubmissionSessionDoc | null> {
  const snapshot = await assignmentSubmissionSessionsCollection().where("sessionRef", "==", sessionRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = assignmentSubmissionSessionDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

// The public route's own lookup - by tokenHash, which IS the doc id (O(1),
// no query/index needed for this hot path).
export async function getSubmissionSessionDocByTokenHash(tokenHash: string): Promise<AssignmentSubmissionSessionDoc | null> {
  const snapshot = await assignmentSubmissionSessionsCollection().doc(tokenHash).get();
  if (!snapshot.exists) return null;
  const result = assignmentSubmissionSessionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export type AssignmentMutationResult = { kind: "ok"; doc: AssignmentDoc } | { kind: "stale" } | { kind: "not_found" };

// Shared transactional "read current, verify optimistic version, apply a
// pure patch, write" primitive - same discipline as Campaigns'/Vendors'
// own runCampaignMutation/runVendorMutation. Used by every ordinary
// Assignment field mutation; lifecycle transitions (which need extra
// preconditions) run their own transaction instead (see
// assignment-lifecycle-service.ts).
export async function runAssignmentMutation(assignmentUid: string, expectedVersion: number, mutate: (current: AssignmentDoc) => AssignmentDoc): Promise<AssignmentMutationResult> {
  const db = getAdminFirestore();
  const docRef = assignmentsCollection().doc(assignmentUid);

  return db.runTransaction<AssignmentMutationResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsed = assignmentDocSchema.safeParse(snap.data());
    if (!parsed.success) return { kind: "not_found" };
    const current = parsed.data;

    if (current.version !== expectedVersion) return { kind: "stale" };

    const next = { ...mutate(current), version: current.version + 1 };
    tx.set(docRef, next);
    return { kind: "ok", doc: next };
  });
}

// Opaque to callers - one entry per active branch (see
// planAssignmentListQuery), keyed by branch name. Echoed back unchanged.
export type AssignmentListCursor = CompoundListCursor;
export type ListAssignmentsPage = { assignments: AssignmentDoc[]; nextCursor: AssignmentListCursor | null };

function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

export type AssignmentListQueryOptions = {
  actorUid: string;
  grants: ScopeGrant[];
  hasGlobal: boolean;
  status?: string;
  campaignRef?: string;
  partnerRef?: string;
  platform?: string;
  ownerUid?: string;
};

// Step 10A: pure query planner - builds the branch plan only, never
// touches Firestore. Exported for unit tests. Mirrors Campaigns' own
// planCampaignListQuery, simplified since Assignment has no dedicated
// scope-grant type (judgment call #4 - the explicit branch is
// EXPLICIT_RECORD("assignment", uid) alone, never merged with a second
// grant type) and no caller-facing multi-region filter (region/team are
// scope dimensions only here, never a requested business filter the way
// Campaign's own `region` param is) - `platform` is the only requested
// business filter, so the push/postFilter arbitration Campaign needs
// between two competing array filters collapses to a single one.
export function planAssignmentListQuery(options: AssignmentListQueryOptions): { plan: ListQueryPlan; orderField: string; orderDirection: SortDirection } {
  const sharedFilters: FirestoreFieldFilter[] = [];
  if (options.status) sharedFilters.push({ field: "status", op: "==", value: options.status });
  if (options.campaignRef) sharedFilters.push({ field: "campaignRef", op: "==", value: options.campaignRef });
  if (options.partnerRef) sharedFilters.push({ field: "partnerRef", op: "==", value: options.partnerRef });
  if (options.ownerUid) sharedFilters.push({ field: "ownerUid", op: "==", value: options.ownerUid });

  const orderField = "createdAt";
  const orderDirection: SortDirection = "desc";

  const platformFilter: FirestoreFieldFilter | null = options.platform ? { field: "brief.platforms", op: "array-contains", value: options.platform } : null;

  const branches: ListBranchPlan[] = [];

  const explicitAssignmentUids = [
    ...new Set(
      options.grants.filter((g): g is Extract<ScopeGrant, { type: "EXPLICIT_RECORD" }> => g.type === "EXPLICIT_RECORD" && g.resourceType === "assignment").map((g) => g.resourceId),
    ),
  ].slice(0, MAX_SCOPE_IN_VALUES);

  if (options.hasGlobal) {
    branches.push({
      kind: "firestore-query",
      name: "main",
      pushedFilters: [...sharedFilters, ...(platformFilter ? [platformFilter] : [])],
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

  const selfExclude: FirestoreFieldFilter = { field: "ownerUid", op: "==", value: options.actorUid };
  const regionExclude: FirestoreFieldFilter | null = grantedRegions.length > 0 ? { field: "regionIds", op: "array-contains-any", value: grantedRegions } : null;
  const teamExclude: FirestoreFieldFilter | null = grantedTeams.length > 0 ? { field: "teamIds", op: "array-contains-any", value: grantedTeams } : null;

  if (selfGranted) {
    branches.push({
      kind: "firestore-query",
      name: "self",
      pushedFilters: [selfExclude, ...sharedFilters, ...(platformFilter ? [platformFilter] : [])],
      postFilters: [],
      excludePostFilters: [],
      orderField,
      orderDirection,
    });
  }

  if (regionExclude) {
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
      postFilters: platformFilter ? [platformFilter] : [],
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(regionExclude ? [regionExclude] : [])],
      orderField,
      orderDirection,
    });
  }

  if (explicitAssignmentUids.length > 0) {
    branches.push({
      kind: "bounded-ids",
      name: "explicit",
      ids: explicitAssignmentUids,
      postFilters: [...sharedFilters, ...(platformFilter ? [platformFilter] : [])],
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(regionExclude ? [regionExclude] : []), ...(teamExclude ? [teamExclude] : [])],
    });
  }

  return { plan: { branches }, orderField, orderDirection };
}

// Bounded cursor pagination, scope-constrained BEFORE retrieval - never a
// browser or server fetch-all followed by in-memory filtering. Mirrors
// Campaigns' listCampaignDocs exactly.
export async function listAssignmentDocs(options: AssignmentListQueryOptions & { limit: number; cursor?: AssignmentListCursor }): Promise<ListAssignmentsPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_ASSIGNMENT_PAGE_SIZE));
  const { plan, orderField, orderDirection } = planAssignmentListQuery(options);
  assertProductionValidPlan(plan);
  if (plan.branches.length === 0) return { assignments: [], nextCursor: null };

  const collection = assignmentsCollection();
  const cursorIn = options.cursor ?? {};
  const branchBatches: Array<{ name: string; items: MergeCandidate<AssignmentDoc>[] }> = [];
  const nextCursorBuilders: Array<(consumed: number) => [string, BranchCursorState] | null> = [];

  for (const branch of plan.branches) {
    if (branch.kind === "bounded-ids") {
      const previous = cursorIn[branch.name];
      if (previous && "exhausted" in previous) continue;
      const previousIndex = previous && "index" in previous ? previous.index : 0;

      const rawDocs = await executeBoundedIdsBranch(collection, branch);
      const survivors: MergeCandidate<AssignmentDoc>[] = [];
      for (const doc of rawDocs) {
        const data = doc.data();
        if (!passesBranchPostFilters(data, branch)) continue;
        const parsed = assignmentDocSchema.safeParse(data);
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
    const survivors: MergeCandidate<AssignmentDoc>[] = [];
    rawDocs.forEach((doc, rawIndex) => {
      const data = doc.data();
      if (!passesBranchPostFilters(data, branch)) return;
      const parsed = assignmentDocSchema.safeParse(data);
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

  return { assignments: page, nextCursor: page.length === pageSize && anyResumable ? nextCursor : null };
}
