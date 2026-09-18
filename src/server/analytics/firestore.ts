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
  analyticsChannelSourceRecordDocSchema,
  analyticsContentSourceRecordDocSchema,
  analyticsImportBatchClaimDocSchema,
  analyticsImportBatchDocSchema,
  type AnalyticsChannelSourceRecordDoc,
  type AnalyticsContentSourceRecordDoc,
  type AnalyticsImportBatchClaimDoc,
  type AnalyticsImportBatchDoc,
} from "./types";

const MAX_SCOPE_IN_VALUES = 30;

export const ANALYTICS_COLLECTIONS = {
  analyticsImportBatches: "analyticsImportBatches",
  analyticsImportBatchClaims: "analyticsImportBatchClaims",
  analyticsContentSourceRecords: "analyticsContentSourceRecords",
  analyticsChannelSourceRecords: "analyticsChannelSourceRecords",
  // Subcollection name under each source-record doc.
  corrections: "corrections",
  analyticsReadModelSnapshots: "analyticsReadModelSnapshots",
} as const;

export const MAX_ANALYTICS_PAGE_SIZE = 100;
export const DEFAULT_ANALYTICS_PAGE_SIZE = 20;

export function analyticsImportBatchesCollection() {
  return getAdminFirestore().collection(ANALYTICS_COLLECTIONS.analyticsImportBatches);
}

export function analyticsImportBatchClaimsCollection() {
  return getAdminFirestore().collection(ANALYTICS_COLLECTIONS.analyticsImportBatchClaims);
}

export function analyticsContentSourceRecordsCollection() {
  return getAdminFirestore().collection(ANALYTICS_COLLECTIONS.analyticsContentSourceRecords);
}

export function analyticsChannelSourceRecordsCollection() {
  return getAdminFirestore().collection(ANALYTICS_COLLECTIONS.analyticsChannelSourceRecords);
}

export function analyticsContentSourceRecordCorrectionsCollection(recordUid: string) {
  return analyticsContentSourceRecordsCollection().doc(recordUid).collection(ANALYTICS_COLLECTIONS.corrections);
}

export function analyticsChannelSourceRecordCorrectionsCollection(recordUid: string) {
  return analyticsChannelSourceRecordsCollection().doc(recordUid).collection(ANALYTICS_COLLECTIONS.corrections);
}

export function analyticsReadModelSnapshotsCollection() {
  return getAdminFirestore().collection(ANALYTICS_COLLECTIONS.analyticsReadModelSnapshots);
}

// A raw hex sha256 is a perfectly valid, deterministic, collision-safe
// Firestore doc id - same idiom as Content's own contentPublicationClaimId.
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256HexBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function analyticsImportBatchClaimId(sourceHash: string): string {
  return sha256Hex(`batch:${sourceHash}`);
}

export function analyticsRowIdentityDocId(rowIdentityKey: string): string {
  return sha256Hex(rowIdentityKey);
}

export async function getAnalyticsImportBatchByUid(uid: string): Promise<AnalyticsImportBatchDoc | null> {
  const snapshot = await analyticsImportBatchesCollection().doc(uid).get();
  if (!snapshot.exists) return null;
  const result = analyticsImportBatchDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getAnalyticsImportBatchByRef(batchRef: string): Promise<AnalyticsImportBatchDoc | null> {
  const snapshot = await analyticsImportBatchesCollection().where("batchRef", "==", batchRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = analyticsImportBatchDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

const TERMINAL_BATCH_STATUSES = ["COMPLETED", "COMPLETED_WITH_ERRORS"] as const;

// The batch-level idempotency lookup: an existing batch that already
// finished (successfully or with partial errors) for this exact file
// content is the source of truth an identical re-upload must reuse,
// never duplicate.
export async function getCompletedAnalyticsImportBatchBySourceHash(sourceHash: string): Promise<AnalyticsImportBatchDoc | null> {
  const snapshot = await analyticsImportBatchesCollection().where("sourceHash", "==", sourceHash).where("status", "in", [...TERMINAL_BATCH_STATUSES]).limit(1).get();
  if (snapshot.empty) return null;
  const result = analyticsImportBatchDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export async function getAnalyticsImportBatchClaim(sourceHash: string): Promise<AnalyticsImportBatchClaimDoc | null> {
  const snapshot = await analyticsImportBatchClaimsCollection().doc(analyticsImportBatchClaimId(sourceHash)).get();
  if (!snapshot.exists) return null;
  const result = analyticsImportBatchClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// A batch whose own supersedesBatchRef already points somewhere - used by
// the stale-correction-cannot-overwrite-a-newer-revision guard
// (import-service.ts). Bounded: a correction lineage realistically never
// has more than a handful of links, but this is still a real, indexed
// equality query, never a fetch-all.
export async function findAnalyticsImportBatchSupersededBy(supersedesBatchRef: string): Promise<AnalyticsImportBatchDoc | null> {
  const snapshot = await analyticsImportBatchesCollection().where("supersedesBatchRef", "==", supersedesBatchRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = analyticsImportBatchDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export async function getAnalyticsContentSourceRecordByUid(uid: string): Promise<AnalyticsContentSourceRecordDoc | null> {
  const snapshot = await analyticsContentSourceRecordsCollection().doc(uid).get();
  if (!snapshot.exists) return null;
  const result = analyticsContentSourceRecordDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getAnalyticsContentSourceRecordByRef(sourceRef: string): Promise<AnalyticsContentSourceRecordDoc | null> {
  const snapshot = await analyticsContentSourceRecordsCollection().where("sourceRef", "==", sourceRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = analyticsContentSourceRecordDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export async function getAnalyticsChannelSourceRecordByUid(uid: string): Promise<AnalyticsChannelSourceRecordDoc | null> {
  const snapshot = await analyticsChannelSourceRecordsCollection().doc(uid).get();
  if (!snapshot.exists) return null;
  const result = analyticsChannelSourceRecordDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getAnalyticsChannelSourceRecordByRef(sourceRef: string): Promise<AnalyticsChannelSourceRecordDoc | null> {
  const snapshot = await analyticsChannelSourceRecordsCollection().where("sourceRef", "==", sourceRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = analyticsChannelSourceRecordDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

// Bounded lookup of a Content thread matched to a given Campaign - used
// by campaign-readiness.ts. Never unbounded: capped at a generous but
// real ceiling, same discipline as every other bounded scan in this
// codebase.
export const MAX_CAMPAIGN_READINESS_RECORDS = 500;

// ---- Scoped, cursor-paginated source-record list queries (Section 15) --
// Mirrors Content's own planContentListQuery/listContentDocs pattern
// exactly (src/server/content/firestore.ts) - same scoped-list.ts
// branch-planner primitives, same SELF/REGION/TEAM/GLOBAL branch
// decomposition. Deliberately does NOT use the existing
// ANALYTICS_DATASET/ANALYTICS_ACCOUNT scope grant types (scope.ts already
// defines isAnalyticsDatasetInScope/isAnalyticsAccountInScope, and
// seed-access-data.ts already seeds two such grants for `analyst`) -
// those remain what scope.ts's own header comment already calls them,
// "representative descriptors" not yet wired to any real record; source
// records here are scoped via the denormalized ownerUid/regionIds/teamIds
// projection instead (see types.ts's own comment on that projection),
// the exact same mechanism Content itself uses. No EXPLICIT_RECORD branch
// either - nothing in this domain grants one yet.
export const MAX_ANALYTICS_SOURCE_RECORD_PAGE_SIZE = 100;
export type AnalyticsSourceRecordListCursor = CompoundListCursor;

export type AnalyticsSourceRecordListQueryOptions = {
  actorUid: string;
  grants: ScopeGrant[];
  hasGlobal: boolean;
  matchState?: string;
  platform?: string;
  batchRef?: string;
  matchedCampaignRef?: string;
  matchedPartnerRef?: string;
  matchedPartnerAccountRef?: string;
  matchedContentRef?: string;
};

function readAnalyticsFieldPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

export function planAnalyticsSourceRecordListQuery(options: AnalyticsSourceRecordListQueryOptions): { plan: ListQueryPlan; orderField: string; orderDirection: SortDirection } {
  const sharedFilters: FirestoreFieldFilter[] = [];
  if (options.matchState) sharedFilters.push({ field: "matchState", op: "==", value: options.matchState });
  if (options.platform) sharedFilters.push({ field: "platform", op: "==", value: options.platform });
  if (options.batchRef) sharedFilters.push({ field: "batchRef", op: "==", value: options.batchRef });
  if (options.matchedCampaignRef) sharedFilters.push({ field: "matchedCampaignRef", op: "==", value: options.matchedCampaignRef });
  if (options.matchedPartnerRef) sharedFilters.push({ field: "matchedPartnerRef", op: "==", value: options.matchedPartnerRef });
  if (options.matchedPartnerAccountRef) sharedFilters.push({ field: "matchedPartnerAccountRef", op: "==", value: options.matchedPartnerAccountRef });
  if (options.matchedContentRef) sharedFilters.push({ field: "matchedContentRef", op: "==", value: options.matchedContentRef });

  const orderField = "createdAt";
  const orderDirection: SortDirection = "desc";
  const branches: ListBranchPlan[] = [];

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

  return { plan: { branches }, orderField, orderDirection };
}

async function listScopedAnalyticsSourceRecords<T extends { createdAt: string }>(
  collection: FirebaseFirestore.CollectionReference,
  schema: { safeParse: (data: unknown) => { success: boolean; data?: T } },
  options: AnalyticsSourceRecordListQueryOptions & { limit: number; cursor?: AnalyticsSourceRecordListCursor },
): Promise<{ records: T[]; nextCursor: AnalyticsSourceRecordListCursor | null }> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_ANALYTICS_SOURCE_RECORD_PAGE_SIZE));
  const { plan, orderField, orderDirection } = planAnalyticsSourceRecordListQuery(options);
  assertProductionValidPlan(plan);
  if (plan.branches.length === 0) return { records: [], nextCursor: null };

  const cursorIn = options.cursor ?? {};
  const branchBatches: Array<{ name: string; items: MergeCandidate<T>[] }> = [];
  const nextCursorBuilders: Array<(consumed: number) => [string, BranchCursorState] | null> = [];

  for (const branch of plan.branches) {
    if (branch.kind === "bounded-ids") {
      const previous = cursorIn[branch.name];
      if (previous && "exhausted" in previous) continue;
      const previousIndex = previous && "index" in previous ? previous.index : 0;

      const rawDocs = await executeBoundedIdsBranch(collection, branch);
      const survivors: MergeCandidate<T>[] = [];
      for (const doc of rawDocs) {
        const data = doc.data();
        if (!passesBranchPostFilters(data, branch)) continue;
        const parsed = schema.safeParse(data);
        if (!parsed.success || !parsed.data) continue;
        survivors.push({ doc: parsed.data, sortValue: String(readAnalyticsFieldPath(data, orderField) ?? ""), uid: doc.id });
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
    const survivors: MergeCandidate<T>[] = [];
    rawDocs.forEach((doc, rawIndex) => {
      const data = doc.data();
      if (!passesBranchPostFilters(data, branch)) return;
      const parsed = schema.safeParse(data);
      if (!parsed.success || !parsed.data) return;
      survivorRawIndexes.push(rawIndex);
      survivors.push({ doc: parsed.data, sortValue: String(readAnalyticsFieldPath(data, orderField) ?? ""), uid: doc.id });
    });

    branchBatches.push({ name: branch.name, items: survivors });
    nextCursorBuilders.push((consumedHere: number) => {
      const state = nextFirestoreBranchCursor({
        fetch: { rawDocs: rawDocs.map((d) => ({ orderValue: String(readAnalyticsFieldPath(d.data(), orderField) ?? ""), uid: d.id })), hasMoreInBranch },
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

  return { records: page, nextCursor: page.length === pageSize && anyResumable ? nextCursor : null };
}

export async function listAnalyticsContentSourceRecordDocs(
  options: AnalyticsSourceRecordListQueryOptions & { limit: number; cursor?: AnalyticsSourceRecordListCursor },
): Promise<{ records: AnalyticsContentSourceRecordDoc[]; nextCursor: AnalyticsSourceRecordListCursor | null }> {
  return listScopedAnalyticsSourceRecords(analyticsContentSourceRecordsCollection(), analyticsContentSourceRecordDocSchema, options);
}

export async function listAnalyticsChannelSourceRecordDocs(
  options: AnalyticsSourceRecordListQueryOptions & { limit: number; cursor?: AnalyticsSourceRecordListCursor },
): Promise<{ records: AnalyticsChannelSourceRecordDoc[]; nextCursor: AnalyticsSourceRecordListCursor | null }> {
  return listScopedAnalyticsSourceRecords(analyticsChannelSourceRecordsCollection(), analyticsChannelSourceRecordDocSchema, options);
}
