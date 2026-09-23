import type { ScopeGrant } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
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

import { payableEventSchema, payableHeadDocSchema, payableVersionDocSchema, type PayableEvent, type PayableHeadDoc, type PayableVersionDoc } from "./types";

// Step 15A: collection accessors + parse-on-read / parse-on-write helpers for the Finance
// Payables domain.
//
// There is deliberately NO delete anywhere in this module - not a helper, not a batch, not a
// transaction delete. A Payable is voided, never removed, and a version is never rewritten
// (only `txCreatePayableVersion` exists; there is no txSet for a version). A static boundary
// test enforces both.

export const FINANCE_PAYABLE_COLLECTIONS = {
  financePayables: "financePayables",
  versions: "versions", // subcollection under financePayables/{payableRef}
  events: "events", // subcollection under financePayables/{payableRef}
} as const;

export const MAX_PAYABLE_VERSION_SUMMARIES = 50;
export const DEFAULT_PAYABLE_EVENT_PAGE = 50;
export const MAX_PAYABLE_EVENT_PAGE = 100;

export function financePayablesCollection() {
  return getAdminFirestore().collection(FINANCE_PAYABLE_COLLECTIONS.financePayables);
}

export function financePayableVersionsCollection(payableRef: string) {
  return financePayablesCollection().doc(payableRef).collection(FINANCE_PAYABLE_COLLECTIONS.versions);
}

export function financePayableEventsCollection(payableRef: string) {
  return financePayablesCollection().doc(payableRef).collection(FINANCE_PAYABLE_COLLECTIONS.events);
}

// Version doc ids are the plain integer as a string ("1", "2", ...) - the deterministic id makes
// "exactly one version N" a document-existence fact (tx.create fails on a duplicate). Ordering
// never relies on the id (it would sort "10" before "2"); list order is the numeric `version`.
export function payableVersionDocId(version: number): string {
  return String(version);
}

// --- Reads: safeParse, null on missing or malformed --------------------------------------------------------------------
export async function getPayableHeadDoc(payableRef: string): Promise<PayableHeadDoc | null> {
  const snapshot = await financePayablesCollection().doc(payableRef).get();
  if (!snapshot.exists) return null;
  const result = payableHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getPayableVersionDoc(payableRef: string, version: number): Promise<PayableVersionDoc | null> {
  const snapshot = await financePayableVersionsCollection(payableRef).doc(payableVersionDocId(version)).get();
  if (!snapshot.exists) return null;
  const result = payableVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Bounded, newest-first list of one Payable's versions (a single-field order on the numeric
// `version`, served by the automatic index - no composite needed).
export async function listPayableVersionDocs(payableRef: string, limit = MAX_PAYABLE_VERSION_SUMMARIES): Promise<{ versions: PayableVersionDoc[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_PAYABLE_VERSION_SUMMARIES));
  const snapshot = await financePayableVersionsCollection(payableRef)
    .orderBy("version", "desc")
    .limit(bound + 1)
    .get();

  const versions: PayableVersionDoc[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = payableVersionDocSchema.safeParse(doc.data());
    if (parsed.success) versions.push(parsed.data);
  }
  return { versions, hasMore: snapshot.docs.length > bound };
}

// Bounded, newest-first page of one Payable's audit events (a single-field order on `createdAt`,
// served by the automatic index).
export async function listPayableEventDocs(payableRef: string, limit = DEFAULT_PAYABLE_EVENT_PAGE): Promise<{ events: PayableEvent[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_PAYABLE_EVENT_PAGE));
  const snapshot = await financePayableEventsCollection(payableRef)
    .orderBy("createdAt", "desc")
    .limit(bound + 1)
    .get();

  const events: PayableEvent[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = payableEventSchema.safeParse(doc.data());
    if (parsed.success) events.push(parsed.data);
  }
  return { events, hasMore: snapshot.docs.length > bound };
}

// --- In-transaction reads (Firestore requires every read before any write) -----------------------------------------------
export async function txGetPayableHead(tx: FirebaseFirestore.Transaction, payableRef: string): Promise<PayableHeadDoc | null> {
  const snapshot = await tx.get(financePayablesCollection().doc(payableRef));
  if (!snapshot.exists) return null;
  const result = payableHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Whether a head document EXISTS at all, regardless of whether it still parses. A malformed head
// must never be treated as "absent" by a create (that would overwrite financial history).
export async function txPayableHeadExists(tx: FirebaseFirestore.Transaction, payableRef: string): Promise<boolean> {
  const snapshot = await tx.get(financePayablesCollection().doc(payableRef));
  return snapshot.exists;
}

export async function txGetPayableVersion(tx: FirebaseFirestore.Transaction, payableRef: string, version: number): Promise<PayableVersionDoc | null> {
  const snapshot = await tx.get(financePayableVersionsCollection(payableRef).doc(payableVersionDocId(version)));
  if (!snapshot.exists) return null;
  const result = payableVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// --- In-transaction writes: parsed on WRITE, so an invalid doc can never be persisted -------------------------------------
// `create` fails the transaction if the doc already exists (the concurrency guarantee for
// "exactly one canonical Payable / version N"). There is NO version `set`: a Payable version is
// immutable once written.
export function txCreatePayableHead(tx: FirebaseFirestore.Transaction, head: PayableHeadDoc): void {
  tx.create(financePayablesCollection().doc(head.payableRef), payableHeadDocSchema.parse(head));
}

export function txSetPayableHead(tx: FirebaseFirestore.Transaction, head: PayableHeadDoc): void {
  tx.set(financePayablesCollection().doc(head.payableRef), payableHeadDocSchema.parse(head));
}

export function txCreatePayableVersion(tx: FirebaseFirestore.Transaction, version: PayableVersionDoc): void {
  tx.create(financePayableVersionsCollection(version.payableRef).doc(payableVersionDocId(version.version)), payableVersionDocSchema.parse(version));
}

// --- Scoped head list ------------------------------------------------------------------------------------------------------
// Bounded, scope-FIRST cursor pagination over Payable heads, mirroring listAgreementHeadDocs
// exactly. Scope is decomposed into independent, individually production-valid branches - SELF via
// ownerUid, REGION / TEAM via array-contains-any on the head's point-in-time scope snapshot,
// PARTNER-type / EXPLICIT partner grants via `partnerUid in [...]`, EXPLICIT vendor grants via
// `vendorUid in [...]` - each paginated on its own and merged by (updatedAt desc, doc id).
// Lower-priority branches exclude what a higher-priority one already surfaces, so a head is only
// ever produced by one branch. The snapshot only decides what is READ; the caller re-verifies
// every surfaced head against its LIVE Partner / Vendor.
//
// NO business filter (status / counterparty type / counterparty / commercial period) is pushed to
// Firestore - they are applied in memory over the bounded set - so the composite index set stays
// at exactly the five scope shapes below. The head nevertheless carries every one of those filter
// dimensions as a top-level, indexable scalar (`status`, `counterpartyType`, `counterpartyRef`,
// `periodKey`, `createdAt`, `updatedAt`), so a future step can push one without reshaping data.
export const MAX_PAYABLE_HEAD_PAGE_SIZE = 100;
const MAX_SCOPE_IN_VALUES = 30;

export type PayableHeadListCursor = CompoundListCursor;
export type ListPayableHeadsPage = { heads: PayableHeadDoc[]; nextCursor: PayableHeadListCursor | null };
export type PayableHeadListQueryOptions = { actorUid: string; grants: ScopeGrant[]; hasGlobal: boolean };

function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

export function planPayableHeadListQuery(options: PayableHeadListQueryOptions): { plan: ListQueryPlan; orderField: string; orderDirection: SortDirection } {
  const orderField = "updatedAt";
  const orderDirection: SortDirection = "desc";
  const branches: ListBranchPlan[] = [];

  if (options.hasGlobal) {
    branches.push({ kind: "firestore-query", name: "main", pushedFilters: [], postFilters: [], excludePostFilters: [], orderField, orderDirection });
    return { plan: { branches }, orderField, orderDirection };
  }

  const selfGranted = options.grants.some((g) => g.type === "SELF");
  const grantedRegions = [...new Set(options.grants.filter((g): g is Extract<ScopeGrant, { type: "REGION" }> => g.type === "REGION").map((g) => g.region))].slice(0, MAX_SCOPE_IN_VALUES);
  const grantedTeams = [...new Set(options.grants.filter((g): g is Extract<ScopeGrant, { type: "TEAM" }> => g.type === "TEAM").map((g) => g.teamId))].slice(0, MAX_SCOPE_IN_VALUES);
  const grantedPartnerUids = [
    ...new Set([
      ...options.grants.filter((g): g is Extract<ScopeGrant, { type: "PARTNER" }> => g.type === "PARTNER").map((g) => g.partnerId),
      ...options.grants.filter((g): g is Extract<ScopeGrant, { type: "EXPLICIT_RECORD" }> => g.type === "EXPLICIT_RECORD" && g.resourceType === "partner").map((g) => g.resourceId),
    ]),
  ].slice(0, MAX_SCOPE_IN_VALUES);
  const grantedVendorUids = [...new Set(options.grants.filter((g): g is Extract<ScopeGrant, { type: "EXPLICIT_RECORD" }> => g.type === "EXPLICIT_RECORD" && g.resourceType === "vendor").map((g) => g.resourceId))].slice(0, MAX_SCOPE_IN_VALUES);

  const selfExclude: FirestoreFieldFilter = { field: "ownerUid", op: "==", value: options.actorUid };
  const regionExclude: FirestoreFieldFilter | null = grantedRegions.length > 0 ? { field: "regionIds", op: "array-contains-any", value: grantedRegions } : null;
  const teamExclude: FirestoreFieldFilter | null = grantedTeams.length > 0 ? { field: "teamIds", op: "array-contains-any", value: grantedTeams } : null;
  const higher = [...(selfGranted ? [selfExclude] : []), ...(regionExclude ? [regionExclude] : []), ...(teamExclude ? [teamExclude] : [])];

  if (selfGranted) branches.push({ kind: "firestore-query", name: "self", pushedFilters: [selfExclude], postFilters: [], excludePostFilters: [], orderField, orderDirection });
  if (regionExclude) branches.push({ kind: "firestore-query", name: "region", pushedFilters: [regionExclude], postFilters: [], excludePostFilters: selfGranted ? [selfExclude] : [], orderField, orderDirection });
  if (teamExclude) branches.push({ kind: "firestore-query", name: "team", pushedFilters: [teamExclude], postFilters: [], excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(regionExclude ? [regionExclude] : [])], orderField, orderDirection });
  if (grantedPartnerUids.length > 0) branches.push({ kind: "firestore-query", name: "partnerGrant", pushedFilters: [{ field: "partnerUid", op: "in", value: grantedPartnerUids }], postFilters: [], excludePostFilters: higher, orderField, orderDirection });
  if (grantedVendorUids.length > 0) branches.push({ kind: "firestore-query", name: "vendorGrant", pushedFilters: [{ field: "vendorUid", op: "in", value: grantedVendorUids }], postFilters: [], excludePostFilters: higher, orderField, orderDirection });

  return { plan: { branches }, orderField, orderDirection };
}

export async function listPayableHeadDocs(options: PayableHeadListQueryOptions & { limit: number; cursor?: PayableHeadListCursor }): Promise<ListPayableHeadsPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_PAYABLE_HEAD_PAGE_SIZE));
  const { plan, orderField, orderDirection } = planPayableHeadListQuery(options);
  assertProductionValidPlan(plan);
  if (plan.branches.length === 0) return { heads: [], nextCursor: null };

  const collection = financePayablesCollection();
  const cursorIn = options.cursor ?? {};
  const branchBatches: Array<{ name: string; items: MergeCandidate<PayableHeadDoc>[] }> = [];
  const nextCursorBuilders: Array<(consumed: number) => [string, BranchCursorState] | null> = [];

  for (const branch of plan.branches) {
    if (branch.kind !== "firestore-query") continue;

    const previous = cursorIn[branch.name];
    if (previous && "exhausted" in previous) continue;
    const queryCursor = previous && "orderValue" in previous ? previous : undefined;

    const { docs: rawDocs, hasMoreInBranch } = await executeFirestoreBranch(collection, branch, queryCursor, pageSize);
    const survivorRawIndexes: number[] = [];
    const survivors: MergeCandidate<PayableHeadDoc>[] = [];
    rawDocs.forEach((doc, rawIndex) => {
      const data = doc.data();
      if (!passesBranchPostFilters(data, branch)) return;
      const parsed = payableHeadDocSchema.safeParse(data);
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

  const nextCursor: PayableHeadListCursor = {};
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
