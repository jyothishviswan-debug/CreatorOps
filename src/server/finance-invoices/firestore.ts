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

import { invoiceEventSchema, invoiceHeadDocSchema, invoiceNumberClaimDocSchema, invoiceVersionDocSchema, type InvoiceEvent, type InvoiceHeadDoc, type InvoiceNumberClaimDoc, type InvoiceVersionDoc } from "./types";

// Step 16A: collection accessors + parse-on-read / parse-on-write helpers for the Finance Invoices
// domain.
//
// There is deliberately NO delete anywhere in this module - not a helper, not a batch, not a
// transaction delete. An Invoice is voided, never removed, and a version is never rewritten (only
// `txCreateInvoiceVersion` exists; there is no txSet for a version). A static boundary test
// enforces both.

export const FINANCE_INVOICE_COLLECTIONS = {
  financeInvoices: "financeInvoices",
  versions: "versions", // subcollection under financeInvoices/{invoiceRef}
  events: "events", // subcollection under financeInvoices/{invoiceRef}
  financeInvoiceNumberClaims: "financeInvoiceNumberClaims",
} as const;

export const MAX_INVOICE_VERSION_SUMMARIES = 50;
export const DEFAULT_INVOICE_EVENT_PAGE = 50;
export const MAX_INVOICE_EVENT_PAGE = 100;

export function financeInvoicesCollection() {
  return getAdminFirestore().collection(FINANCE_INVOICE_COLLECTIONS.financeInvoices);
}

export function financeInvoiceVersionsCollection(invoiceRef: string) {
  return financeInvoicesCollection().doc(invoiceRef).collection(FINANCE_INVOICE_COLLECTIONS.versions);
}

export function financeInvoiceEventsCollection(invoiceRef: string) {
  return financeInvoicesCollection().doc(invoiceRef).collection(FINANCE_INVOICE_COLLECTIONS.events);
}

export function financeInvoiceNumberClaimsCollection() {
  return getAdminFirestore().collection(FINANCE_INVOICE_COLLECTIONS.financeInvoiceNumberClaims);
}

// Version doc ids are the plain integer as a string ("1", "2", ...) - identical discipline to
// Payables' own payableVersionDocId.
export function invoiceVersionDocId(version: number): string {
  return String(version);
}

// --- Reads: safeParse, null on missing or malformed --------------------------------------------------------------------
export async function getInvoiceHeadDoc(invoiceRef: string): Promise<InvoiceHeadDoc | null> {
  const snapshot = await financeInvoicesCollection().doc(invoiceRef).get();
  if (!snapshot.exists) return null;
  const result = invoiceHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getInvoiceVersionDoc(invoiceRef: string, version: number): Promise<InvoiceVersionDoc | null> {
  const snapshot = await financeInvoiceVersionsCollection(invoiceRef).doc(invoiceVersionDocId(version)).get();
  if (!snapshot.exists) return null;
  const result = invoiceVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getInvoiceNumberClaimDoc(claimId: string): Promise<InvoiceNumberClaimDoc | null> {
  const snapshot = await financeInvoiceNumberClaimsCollection().doc(claimId).get();
  if (!snapshot.exists) return null;
  const result = invoiceNumberClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Bounded, newest-first list of one Invoice's versions (single-field order on the numeric
// `version`, served by the automatic index - no composite needed).
export async function listInvoiceVersionDocs(invoiceRef: string, limit = MAX_INVOICE_VERSION_SUMMARIES): Promise<{ versions: InvoiceVersionDoc[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_INVOICE_VERSION_SUMMARIES));
  const snapshot = await financeInvoiceVersionsCollection(invoiceRef)
    .orderBy("version", "desc")
    .limit(bound + 1)
    .get();

  const versions: InvoiceVersionDoc[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = invoiceVersionDocSchema.safeParse(doc.data());
    if (parsed.success) versions.push(parsed.data);
  }
  return { versions, hasMore: snapshot.docs.length > bound };
}

// Bounded, newest-first page of one Invoice's audit events (single-field order on `createdAt`).
export async function listInvoiceEventDocs(invoiceRef: string, limit = DEFAULT_INVOICE_EVENT_PAGE): Promise<{ events: InvoiceEvent[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_INVOICE_EVENT_PAGE));
  const snapshot = await financeInvoiceEventsCollection(invoiceRef)
    .orderBy("createdAt", "desc")
    .limit(bound + 1)
    .get();

  const events: InvoiceEvent[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = invoiceEventSchema.safeParse(doc.data());
    if (parsed.success) events.push(parsed.data);
  }
  return { events, hasMore: snapshot.docs.length > bound };
}

// --- In-transaction reads (Firestore requires every read before any write) -----------------------------------------------
export async function txGetInvoiceHead(tx: FirebaseFirestore.Transaction, invoiceRef: string): Promise<InvoiceHeadDoc | null> {
  const snapshot = await tx.get(financeInvoicesCollection().doc(invoiceRef));
  if (!snapshot.exists) return null;
  const result = invoiceHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Whether a head document EXISTS at all, regardless of whether it still parses. A malformed head
// must never be treated as "absent" by a create (that would overwrite financial history).
export async function txInvoiceHeadExists(tx: FirebaseFirestore.Transaction, invoiceRef: string): Promise<boolean> {
  const snapshot = await tx.get(financeInvoicesCollection().doc(invoiceRef));
  return snapshot.exists;
}

export async function txGetInvoiceVersion(tx: FirebaseFirestore.Transaction, invoiceRef: string, version: number): Promise<InvoiceVersionDoc | null> {
  const snapshot = await tx.get(financeInvoiceVersionsCollection(invoiceRef).doc(invoiceVersionDocId(version)));
  if (!snapshot.exists) return null;
  const result = invoiceVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function txGetInvoiceNumberClaim(tx: FirebaseFirestore.Transaction, claimId: string): Promise<InvoiceNumberClaimDoc | null> {
  const snapshot = await tx.get(financeInvoiceNumberClaimsCollection().doc(claimId));
  if (!snapshot.exists) return null;
  const result = invoiceNumberClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// --- In-transaction writes: parsed on WRITE, so an invalid doc can never be persisted -------------------------------------
// `create` fails the transaction if the doc already exists (the concurrency guarantee for "at most
// one canonical Invoice per Payable" / "at most one claim per normalized number"). There is NO
// version `set`: an Invoice version is immutable once written.
export function txCreateInvoiceHead(tx: FirebaseFirestore.Transaction, head: InvoiceHeadDoc): void {
  tx.create(financeInvoicesCollection().doc(head.invoiceRef), invoiceHeadDocSchema.parse(head));
}

export function txSetInvoiceHead(tx: FirebaseFirestore.Transaction, head: InvoiceHeadDoc): void {
  tx.set(financeInvoicesCollection().doc(head.invoiceRef), invoiceHeadDocSchema.parse(head));
}

export function txCreateInvoiceVersion(tx: FirebaseFirestore.Transaction, version: InvoiceVersionDoc): void {
  tx.create(financeInvoiceVersionsCollection(version.invoiceRef).doc(invoiceVersionDocId(version.version)), invoiceVersionDocSchema.parse(version));
}

export function txCreateInvoiceNumberClaim(tx: FirebaseFirestore.Transaction, claimId: string, claim: InvoiceNumberClaimDoc): void {
  tx.create(financeInvoiceNumberClaimsCollection().doc(claimId), invoiceNumberClaimDocSchema.parse(claim));
}

// --- Scoped head list ------------------------------------------------------------------------------------------------------
// Bounded, scope-FIRST cursor pagination over Invoice heads, mirroring listPayableHeadDocs exactly.
export const MAX_INVOICE_HEAD_PAGE_SIZE = 100;
const MAX_SCOPE_IN_VALUES = 30;

export type InvoiceHeadListCursor = CompoundListCursor;
export type ListInvoiceHeadsPage = { heads: InvoiceHeadDoc[]; nextCursor: InvoiceHeadListCursor | null };
export type InvoiceHeadListQueryOptions = { actorUid: string; grants: ScopeGrant[]; hasGlobal: boolean };

function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

export function planInvoiceHeadListQuery(options: InvoiceHeadListQueryOptions): { plan: ListQueryPlan; orderField: string; orderDirection: SortDirection } {
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

export async function listInvoiceHeadDocs(options: InvoiceHeadListQueryOptions & { limit: number; cursor?: InvoiceHeadListCursor }): Promise<ListInvoiceHeadsPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_INVOICE_HEAD_PAGE_SIZE));
  const { plan, orderField, orderDirection } = planInvoiceHeadListQuery(options);
  assertProductionValidPlan(plan);
  if (plan.branches.length === 0) return { heads: [], nextCursor: null };

  const collection = financeInvoicesCollection();
  const cursorIn = options.cursor ?? {};
  const branchBatches: Array<{ name: string; items: MergeCandidate<InvoiceHeadDoc>[] }> = [];
  const nextCursorBuilders: Array<(consumed: number) => [string, BranchCursorState] | null> = [];

  for (const branch of plan.branches) {
    if (branch.kind !== "firestore-query") continue;

    const previous = cursorIn[branch.name];
    if (previous && "exhausted" in previous) continue;
    const queryCursor = previous && "orderValue" in previous ? previous : undefined;

    const { docs: rawDocs, hasMoreInBranch } = await executeFirestoreBranch(collection, branch, queryCursor, pageSize);
    const survivorRawIndexes: number[] = [];
    const survivors: MergeCandidate<InvoiceHeadDoc>[] = [];
    rawDocs.forEach((doc, rawIndex) => {
      const data = doc.data();
      if (!passesBranchPostFilters(data, branch)) return;
      const parsed = invoiceHeadDocSchema.safeParse(data);
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

  const nextCursor: InvoiceHeadListCursor = {};
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
