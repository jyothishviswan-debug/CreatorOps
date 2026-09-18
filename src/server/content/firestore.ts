import { createHash } from "node:crypto";

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
import {
  contentDocSchema,
  contentPublicationClaimDocSchema,
  contentRequiredSlotClaimDocSchema,
  contentVersionDocSchema,
  type ContentDoc,
  type ContentPublicationClaimDoc,
  type ContentRequiredSlotClaimDoc,
  type ContentVersionDoc,
} from "./types";

export const CONTENT_COLLECTIONS = {
  content: "content",
  contentEvents: "events", // subcollection name under content/{uid}
  contentVersions: "versions", // subcollection name under content/{uid}
  contentRequiredSlotClaims: "contentRequiredSlotClaims",
  contentPublicationClaims: "contentPublicationClaims",
} as const;

export const MAX_CONTENT_PAGE_SIZE = 100;
export const DEFAULT_CONTENT_PAGE_SIZE = 20;

// Firestore's `in` operator caps at 30 values per query - same bounded
// discipline as every other domain's firestore.ts.
const MAX_SCOPE_IN_VALUES = 30;

export function contentCollection() {
  return getAdminFirestore().collection(CONTENT_COLLECTIONS.content);
}

export function contentEventsCollection(contentUid: string) {
  return contentCollection().doc(contentUid).collection(CONTENT_COLLECTIONS.contentEvents);
}

export function contentVersionsCollection(contentUid: string) {
  return contentCollection().doc(contentUid).collection(CONTENT_COLLECTIONS.contentVersions);
}

// Race-safe required-obligation-slot claims - see types.ts's own comment
// on contentRequiredSlotClaimDocSchema. Doc id is the deterministic
// composite `${assignmentRef}:${slotIndex}` (assignmentActiveClaimDocId's
// own precedent applied here).
export function contentRequiredSlotClaimsCollection() {
  return getAdminFirestore().collection(CONTENT_COLLECTIONS.contentRequiredSlotClaims);
}

export function contentRequiredSlotClaimDocId(assignmentRef: string, slotIndex: number): string {
  return `${assignmentRef}:${slotIndex}`;
}

// Publication identity uniqueness claims - see types.ts's own comment on
// contentPublicationClaimDocSchema. Doc id is sha256(identityKey), the
// exact precedent from src/server/partners/identity.ts's claimIdFor - a
// raw URL/platform-content-id cannot safely be a Firestore doc id itself
// (can contain "/", exceed length limits, etc).
export function contentPublicationClaimsCollection() {
  return getAdminFirestore().collection(CONTENT_COLLECTIONS.contentPublicationClaims);
}

export function contentPublicationClaimId(identityKey: string): string {
  return createHash("sha256").update(identityKey).digest("hex");
}

export async function getContentDocByUid(uid: string): Promise<ContentDoc | null> {
  const snapshot = await contentCollection().doc(uid).get();
  if (!snapshot.exists) return null;
  const result = contentDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Resolves a Content record by its opaque, browser-facing contentRef
// instead of the internal Firestore doc id - same idiom as
// getAssignmentDocByRef. A tampered or made-up token simply matches no
// document.
export async function getContentDocByRef(contentRef: string): Promise<ContentDoc | null> {
  const snapshot = await contentCollection().where("contentRef", "==", contentRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = contentDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

// Bounded bulk-chunked lookup for a page of some OTHER domain's rows that
// each carry a contentRef - same chunking discipline as
// getPartnerDocsByRefs/getCampaignDocsByRefs.
export async function getContentDocsByRefs(contentRefs: string[]): Promise<Map<string, ContentDoc>> {
  const unique = [...new Set(contentRefs)];
  const result = new Map<string, ContentDoc>();
  for (let i = 0; i < unique.length; i += MAX_SCOPE_IN_VALUES) {
    const chunk = unique.slice(i, i + MAX_SCOPE_IN_VALUES);
    if (chunk.length === 0) continue;
    const snapshot = await contentCollection().where("contentRef", "in", chunk).get();
    for (const doc of snapshot.docs) {
      const parsed = contentDocSchema.safeParse(doc.data());
      if (parsed.success) result.set(parsed.data.contentRef, parsed.data);
    }
  }
  return result;
}

export async function getContentRequiredSlotClaim(assignmentRef: string, slotIndex: number): Promise<ContentRequiredSlotClaimDoc | null> {
  const snapshot = await contentRequiredSlotClaimsCollection().doc(contentRequiredSlotClaimDocId(assignmentRef, slotIndex)).get();
  if (!snapshot.exists) return null;
  const result = contentRequiredSlotClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Every required-slot claim for one Assignment - bounded by the
// Assignment's own requiredCount cap (max 1000), used by the fulfillment
// evaluator to count qualifying Content without ever fetching Content
// broadly.
export async function listContentRequiredSlotClaimsForAssignment(assignmentRef: string): Promise<ContentRequiredSlotClaimDoc[]> {
  const snapshot = await contentRequiredSlotClaimsCollection().where("assignmentRef", "==", assignmentRef).get();
  const claims: ContentRequiredSlotClaimDoc[] = [];
  for (const doc of snapshot.docs) {
    const parsed = contentRequiredSlotClaimDocSchema.safeParse(doc.data());
    if (parsed.success) claims.push(parsed.data);
  }
  return claims;
}

export async function getContentPublicationClaimByKey(identityKey: string): Promise<ContentPublicationClaimDoc | null> {
  const snapshot = await contentPublicationClaimsCollection().doc(contentPublicationClaimId(identityKey)).get();
  if (!snapshot.exists) return null;
  const result = contentPublicationClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getContentVersionDoc(contentUid: string, versionUid: string): Promise<ContentVersionDoc | null> {
  const snapshot = await contentVersionsCollection(contentUid).doc(versionUid).get();
  if (!snapshot.exists) return null;
  const result = contentVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getContentVersionDocByNumber(contentUid: string, versionNumber: number): Promise<ContentVersionDoc | null> {
  const snapshot = await contentVersionsCollection(contentUid).where("versionNumber", "==", versionNumber).limit(1).get();
  if (snapshot.empty) return null;
  const result = contentVersionDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export type ContentMutationResult = { kind: "ok"; doc: ContentDoc } | { kind: "stale" } | { kind: "not_found" };

// Shared transactional "read current, verify optimistic version, apply a
// pure patch, write" primitive - same discipline as Assignments' own
// runAssignmentMutation. Lifecycle/fulfillment transitions run their own
// transaction instead (see content-lifecycle-service.ts) since they need
// extra preconditions/cross-document reads.
export async function runContentMutation(contentUid: string, expectedVersion: number, mutate: (current: ContentDoc) => ContentDoc): Promise<ContentMutationResult> {
  const db = getAdminFirestore();
  const docRef = contentCollection().doc(contentUid);

  return db.runTransaction<ContentMutationResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsed = contentDocSchema.safeParse(snap.data());
    if (!parsed.success) return { kind: "not_found" };
    const current = parsed.data;

    if (current.version !== expectedVersion) return { kind: "stale" };

    const next = { ...mutate(current), version: current.version + 1 };
    tx.set(docRef, next);
    return { kind: "ok", doc: next };
  });
}

// Opaque to callers - one entry per active branch (see
// planContentListQuery), echoed back unchanged.
export type ContentListCursor = CompoundListCursor;
export type ListContentPage = { content: ContentDoc[]; nextCursor: ContentListCursor | null };

function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

export type ContentListQueryOptions = {
  actorUid: string;
  grants: ScopeGrant[];
  hasGlobal: boolean;
  status?: string;
  assignmentRef?: string;
  campaignRef?: string;
  partnerRef?: string;
  platform?: string;
  reviewPolicy?: string;
  ownerUid?: string;
};

// Pure query planner - builds the branch plan only, never touches
// Firestore. Exported for unit tests. Mirrors Assignments' own
// planAssignmentListQuery, simplified further: every requested business
// filter here (status/assignmentRef/campaignRef/partnerRef/platform/
// reviewPolicy) is a plain equality filter, never array-type, so - unlike
// Assignment's own `platform` (an array-contains against brief.platforms)
// - there is never a competing second array-type filter to arbitrate
// between a business filter and a REGION/TEAM scope branch's own
// array-contains-any. Every shared filter can therefore be pushed
// directly into every branch, region/team included, with no postFilter
// demotion needed.
export function planContentListQuery(options: ContentListQueryOptions): { plan: ListQueryPlan; orderField: string; orderDirection: SortDirection } {
  const sharedFilters: FirestoreFieldFilter[] = [];
  if (options.status) sharedFilters.push({ field: "status", op: "==", value: options.status });
  if (options.assignmentRef) sharedFilters.push({ field: "assignmentRef", op: "==", value: options.assignmentRef });
  if (options.campaignRef) sharedFilters.push({ field: "campaignRef", op: "==", value: options.campaignRef });
  if (options.partnerRef) sharedFilters.push({ field: "partnerRef", op: "==", value: options.partnerRef });
  if (options.platform) sharedFilters.push({ field: "platform", op: "==", value: options.platform });
  if (options.reviewPolicy) sharedFilters.push({ field: "reviewPolicy", op: "==", value: options.reviewPolicy });
  if (options.ownerUid) sharedFilters.push({ field: "ownerUid", op: "==", value: options.ownerUid });

  const orderField = "createdAt";
  const orderDirection: SortDirection = "desc";

  const branches: ListBranchPlan[] = [];

  const explicitContentUids = [
    ...new Set(options.grants.filter((g): g is Extract<ScopeGrant, { type: "EXPLICIT_RECORD" }> => g.type === "EXPLICIT_RECORD" && g.resourceType === "content").map((g) => g.resourceId)),
  ].slice(0, MAX_SCOPE_IN_VALUES);

  if (options.hasGlobal) {
    branches.push({ kind: "firestore-query", name: "main", pushedFilters: sharedFilters, postFilters: [], excludePostFilters: [], orderField, orderDirection });
    return { plan: { branches }, orderField, orderDirection };
  }

  const selfGranted = options.grants.some((g) => g.type === "SELF");
  const grantedRegions = [...new Set(options.grants.filter((g): g is Extract<ScopeGrant, { type: "REGION" }> => g.type === "REGION").map((g) => g.region))].slice(0, MAX_SCOPE_IN_VALUES);
  const grantedTeams = [...new Set(options.grants.filter((g): g is Extract<ScopeGrant, { type: "TEAM" }> => g.type === "TEAM").map((g) => g.teamId))].slice(0, MAX_SCOPE_IN_VALUES);

  const selfExclude: FirestoreFieldFilter = { field: "ownerUid", op: "==", value: options.actorUid };
  const regionExclude: FirestoreFieldFilter | null = grantedRegions.length > 0 ? { field: "regionIds", op: "array-contains-any", value: grantedRegions } : null;
  const teamExclude: FirestoreFieldFilter | null = grantedTeams.length > 0 ? { field: "teamIds", op: "array-contains-any", value: grantedTeams } : null;

  if (selfGranted) {
    branches.push({ kind: "firestore-query", name: "self", pushedFilters: [selfExclude, ...sharedFilters], postFilters: [], excludePostFilters: [], orderField, orderDirection });
  }

  if (regionExclude) {
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
      postFilters: [],
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(regionExclude ? [regionExclude] : [])],
      orderField,
      orderDirection,
    });
  }

  if (explicitContentUids.length > 0) {
    branches.push({
      kind: "bounded-ids",
      name: "explicit",
      ids: explicitContentUids,
      postFilters: sharedFilters,
      excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(regionExclude ? [regionExclude] : []), ...(teamExclude ? [teamExclude] : [])],
    });
  }

  return { plan: { branches }, orderField, orderDirection };
}

// Bounded cursor pagination, scope-constrained BEFORE retrieval - never a
// fetch-all followed by in-memory filtering. Mirrors Assignments'
// listAssignmentDocs exactly. Deliberately has ZERO composite Firestore
// index entries in firestore.indexes.json (that file is a protected path
// for this step - see this domain's completion report) - the local
// emulator does not require them, and this is the exact same
// zero-index-entries shape Assignments itself already shipped with.
export async function listContentDocs(options: ContentListQueryOptions & { limit: number; cursor?: ContentListCursor }): Promise<ListContentPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_CONTENT_PAGE_SIZE));
  const { plan, orderField, orderDirection } = planContentListQuery(options);
  assertProductionValidPlan(plan);
  if (plan.branches.length === 0) return { content: [], nextCursor: null };

  const collection = contentCollection();
  const cursorIn = options.cursor ?? {};
  const branchBatches: Array<{ name: string; items: MergeCandidate<ContentDoc>[] }> = [];
  const nextCursorBuilders: Array<(consumed: number) => [string, BranchCursorState] | null> = [];

  for (const branch of plan.branches) {
    if (branch.kind === "bounded-ids") {
      const previous = cursorIn[branch.name];
      if (previous && "exhausted" in previous) continue;
      const previousIndex = previous && "index" in previous ? previous.index : 0;

      const rawDocs = await executeBoundedIdsBranch(collection, branch);
      const survivors: MergeCandidate<ContentDoc>[] = [];
      for (const doc of rawDocs) {
        const data = doc.data();
        if (!passesBranchPostFilters(data, branch)) continue;
        const parsed = contentDocSchema.safeParse(data);
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
    const survivors: MergeCandidate<ContentDoc>[] = [];
    rawDocs.forEach((doc, rawIndex) => {
      const data = doc.data();
      if (!passesBranchPostFilters(data, branch)) return;
      const parsed = contentDocSchema.safeParse(data);
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

  return { content: page, nextCursor: page.length === pageSize && anyResumable ? nextCursor : null };
}
