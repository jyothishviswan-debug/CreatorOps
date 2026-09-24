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

import {
  paymentEventSchema,
  paymentHeadDocSchema,
  paymentReferenceClaimDocSchema,
  paymentSettlementAccumulatorDocSchema,
  paymentVersionDocSchema,
  type PaymentEvent,
  type PaymentHeadDoc,
  type PaymentReferenceClaimDoc,
  type PaymentSettlementAccumulatorDoc,
  type PaymentVersionDoc,
} from "./types";

// Step 17A: collection accessors + parse-on-read / parse-on-write helpers for the Finance Payments
// domain. Mirrors src/server/finance-invoices/firestore.ts exactly.
//
// There is deliberately NO delete anywhere in this module - not a helper, not a batch, not a
// transaction delete. A Payment is voided, never removed, and a version is never rewritten (only
// `txCreatePaymentVersion` exists; there is no txSet for a version). A static boundary test
// enforces both.

export const FINANCE_PAYMENT_COLLECTIONS = {
  financePayments: "financePayments",
  versions: "versions", // subcollection under financePayments/{paymentRef}
  events: "events", // subcollection under financePayments/{paymentRef}
  financePaymentReferenceClaims: "financePaymentReferenceClaims",
  financePaymentSettlements: "financePaymentSettlements",
} as const;

export const MAX_PAYMENT_VERSION_SUMMARIES = 50;
export const DEFAULT_PAYMENT_EVENT_PAGE = 50;
export const MAX_PAYMENT_EVENT_PAGE = 100;

export function financePaymentsCollection() {
  return getAdminFirestore().collection(FINANCE_PAYMENT_COLLECTIONS.financePayments);
}

export function financePaymentVersionsCollection(paymentRef: string) {
  return financePaymentsCollection().doc(paymentRef).collection(FINANCE_PAYMENT_COLLECTIONS.versions);
}

export function financePaymentEventsCollection(paymentRef: string) {
  return financePaymentsCollection().doc(paymentRef).collection(FINANCE_PAYMENT_COLLECTIONS.events);
}

export function financePaymentReferenceClaimsCollection() {
  return getAdminFirestore().collection(FINANCE_PAYMENT_COLLECTIONS.financePaymentReferenceClaims);
}

export function financePaymentSettlementsCollection() {
  return getAdminFirestore().collection(FINANCE_PAYMENT_COLLECTIONS.financePaymentSettlements);
}

// Version doc ids are the plain integer as a string ("1", "2", ...) - identical discipline to
// Payables'/Invoices' own version doc ids.
export function paymentVersionDocId(version: number): string {
  return String(version);
}

// --- Reads: safeParse, null on missing or malformed --------------------------------------------------------------------
export async function getPaymentHeadDoc(paymentRef: string): Promise<PaymentHeadDoc | null> {
  const snapshot = await financePaymentsCollection().doc(paymentRef).get();
  if (!snapshot.exists) return null;
  const result = paymentHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getPaymentVersionDoc(paymentRef: string, version: number): Promise<PaymentVersionDoc | null> {
  const snapshot = await financePaymentVersionsCollection(paymentRef).doc(paymentVersionDocId(version)).get();
  if (!snapshot.exists) return null;
  const result = paymentVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getPaymentReferenceClaimDoc(claimId: string): Promise<PaymentReferenceClaimDoc | null> {
  const snapshot = await financePaymentReferenceClaimsCollection().doc(claimId).get();
  if (!snapshot.exists) return null;
  const result = paymentReferenceClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getPaymentSettlementAccumulatorDoc(invoiceRef: string): Promise<PaymentSettlementAccumulatorDoc | null> {
  const snapshot = await financePaymentSettlementsCollection().doc(invoiceRef).get();
  if (!snapshot.exists) return null;
  const result = paymentSettlementAccumulatorDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Bounded, newest-first list of one Payment's versions (single-field order on the numeric
// `version`, served by the automatic index - no composite needed).
export async function listPaymentVersionDocs(paymentRef: string, limit = MAX_PAYMENT_VERSION_SUMMARIES): Promise<{ versions: PaymentVersionDoc[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_PAYMENT_VERSION_SUMMARIES));
  const snapshot = await financePaymentVersionsCollection(paymentRef)
    .orderBy("version", "desc")
    .limit(bound + 1)
    .get();

  const versions: PaymentVersionDoc[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = paymentVersionDocSchema.safeParse(doc.data());
    if (parsed.success) versions.push(parsed.data);
  }
  return { versions, hasMore: snapshot.docs.length > bound };
}

// Bounded, newest-first page of one Payment's audit events (single-field order on `createdAt`).
export async function listPaymentEventDocs(paymentRef: string, limit = DEFAULT_PAYMENT_EVENT_PAGE): Promise<{ events: PaymentEvent[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_PAYMENT_EVENT_PAGE));
  const snapshot = await financePaymentEventsCollection(paymentRef)
    .orderBy("createdAt", "desc")
    .limit(bound + 1)
    .get();

  const events: PaymentEvent[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = paymentEventSchema.safeParse(doc.data());
    if (parsed.success) events.push(parsed.data);
  }
  return { events, hasMore: snapshot.docs.length > bound };
}

// Bounded (never the whole collection - section 18): every Payment version pinned to one Invoice,
// newest first. Used for the read-only settlement projection (never inside a confirm transaction -
// the accumulator document is the concurrency-safe source of truth for that).
export const MAX_PAYMENTS_PER_INVOICE_SCAN = 500;
export async function listPaymentHeadDocsForInvoice(invoiceRef: string, limit = MAX_PAYMENTS_PER_INVOICE_SCAN): Promise<PaymentHeadDoc[]> {
  const snapshot = await financePaymentsCollection().where("invoiceRef", "==", invoiceRef).limit(limit).get();
  const heads: PaymentHeadDoc[] = [];
  for (const doc of snapshot.docs) {
    const parsed = paymentHeadDocSchema.safeParse(doc.data());
    if (parsed.success) heads.push(parsed.data);
  }
  return heads;
}

// --- In-transaction reads (Firestore requires every read before any write) -----------------------------------------------
export async function txGetPaymentHead(tx: FirebaseFirestore.Transaction, paymentRef: string): Promise<PaymentHeadDoc | null> {
  const snapshot = await tx.get(financePaymentsCollection().doc(paymentRef));
  if (!snapshot.exists) return null;
  const result = paymentHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function txGetPaymentVersion(tx: FirebaseFirestore.Transaction, paymentRef: string, version: number): Promise<PaymentVersionDoc | null> {
  const snapshot = await tx.get(financePaymentVersionsCollection(paymentRef).doc(paymentVersionDocId(version)));
  if (!snapshot.exists) return null;
  const result = paymentVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function txGetPaymentReferenceClaim(tx: FirebaseFirestore.Transaction, claimId: string): Promise<PaymentReferenceClaimDoc | null> {
  const snapshot = await tx.get(financePaymentReferenceClaimsCollection().doc(claimId));
  if (!snapshot.exists) return null;
  const result = paymentReferenceClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// THE concurrency-critical read (section 8/19): every CONFIRM transaction reads this exact document
// before deciding whether the new confirmed total would exceed the pinned expected net payment.
export async function txGetPaymentSettlementAccumulator(tx: FirebaseFirestore.Transaction, invoiceRef: string): Promise<PaymentSettlementAccumulatorDoc | null> {
  const snapshot = await tx.get(financePaymentSettlementsCollection().doc(invoiceRef));
  if (!snapshot.exists) return null;
  const result = paymentSettlementAccumulatorDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// --- In-transaction writes: parsed on WRITE, so an invalid doc can never be persisted -------------------------------------
export function txCreatePaymentHead(tx: FirebaseFirestore.Transaction, head: PaymentHeadDoc): void {
  tx.create(financePaymentsCollection().doc(head.paymentRef), paymentHeadDocSchema.parse(head));
}

export function txSetPaymentHead(tx: FirebaseFirestore.Transaction, head: PaymentHeadDoc): void {
  tx.set(financePaymentsCollection().doc(head.paymentRef), paymentHeadDocSchema.parse(head));
}

export function txCreatePaymentVersion(tx: FirebaseFirestore.Transaction, version: PaymentVersionDoc): void {
  tx.create(financePaymentVersionsCollection(version.paymentRef).doc(paymentVersionDocId(version.version)), paymentVersionDocSchema.parse(version));
}

export function txCreatePaymentReferenceClaim(tx: FirebaseFirestore.Transaction, claimId: string, claim: PaymentReferenceClaimDoc): void {
  tx.create(financePaymentReferenceClaimsCollection().doc(claimId), paymentReferenceClaimDocSchema.parse(claim));
}

// Idempotent upsert of the settlement accumulator (create on first confirm for an Invoice, set on
// every subsequent one) - always called with a freshly-read-in-this-transaction value.
export function txSetPaymentSettlementAccumulator(tx: FirebaseFirestore.Transaction, doc: PaymentSettlementAccumulatorDoc): void {
  tx.set(financePaymentSettlementsCollection().doc(doc.invoiceRef), paymentSettlementAccumulatorDocSchema.parse(doc));
}

// --- Scoped head list ------------------------------------------------------------------------------------------------------
// Bounded, scope-FIRST cursor pagination over Payment heads, mirroring listInvoiceHeadDocs exactly.
export const MAX_PAYMENT_HEAD_PAGE_SIZE = 100;
const MAX_SCOPE_IN_VALUES = 30;

export type PaymentHeadListCursor = CompoundListCursor;
export type ListPaymentHeadsPage = { heads: PaymentHeadDoc[]; nextCursor: PaymentHeadListCursor | null };
export type PaymentHeadListQueryOptions = { actorUid: string; grants: ScopeGrant[]; hasGlobal: boolean };

function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

// Mirrors planInvoiceHeadListQuery / planPayableHeadListQuery exactly (SELF > REGION > TEAM >
// PARTNER/VENDOR grant, each its own disjoint branch). Section-18 filters that narrow further
// (invoiceRef, status) are applied as in-memory post-filters by the caller (payment-workspace
// stays small and bounded by construction - section 18 - so this never risks scanning the whole
// collection) rather than folded into the scope branches themselves, keeping this module's index
// footprint identical in shape to Invoices'/Payables' own five entries.
export function planPaymentHeadListQuery(options: PaymentHeadListQueryOptions): { plan: ListQueryPlan; orderField: string; orderDirection: SortDirection } {
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
  if (teamExclude) {
    branches.push({ kind: "firestore-query", name: "team", pushedFilters: [teamExclude], postFilters: [], excludePostFilters: [...(selfGranted ? [selfExclude] : []), ...(regionExclude ? [regionExclude] : [])], orderField, orderDirection });
  }
  if (grantedPartnerUids.length > 0) branches.push({ kind: "firestore-query", name: "partnerGrant", pushedFilters: [{ field: "partnerUid", op: "in", value: grantedPartnerUids }], postFilters: [], excludePostFilters: higher, orderField, orderDirection });
  if (grantedVendorUids.length > 0) branches.push({ kind: "firestore-query", name: "vendorGrant", pushedFilters: [{ field: "vendorUid", op: "in", value: grantedVendorUids }], postFilters: [], excludePostFilters: higher, orderField, orderDirection });

  return { plan: { branches }, orderField, orderDirection };
}

export async function listPaymentHeadDocs(options: PaymentHeadListQueryOptions & { limit: number; cursor?: PaymentHeadListCursor }): Promise<ListPaymentHeadsPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_PAYMENT_HEAD_PAGE_SIZE));
  const { plan, orderField, orderDirection } = planPaymentHeadListQuery(options);
  assertProductionValidPlan(plan);
  if (plan.branches.length === 0) return { heads: [], nextCursor: null };

  const collection = financePaymentsCollection();
  const cursorIn = options.cursor ?? {};
  const branchBatches: Array<{ name: string; items: MergeCandidate<PaymentHeadDoc>[] }> = [];
  const nextCursorBuilders: Array<(consumed: number) => [string, BranchCursorState] | null> = [];

  for (const branch of plan.branches) {
    if (branch.kind !== "firestore-query") continue;

    const previous = cursorIn[branch.name];
    if (previous && "exhausted" in previous) continue;
    const queryCursor = previous && "orderValue" in previous ? previous : undefined;

    const { docs: rawDocs, hasMoreInBranch } = await executeFirestoreBranch(collection, branch, queryCursor, pageSize);
    const survivorRawIndexes: number[] = [];
    const survivors: MergeCandidate<PaymentHeadDoc>[] = [];
    rawDocs.forEach((doc, rawIndex) => {
      const data = doc.data();
      if (!passesBranchPostFilters(data, branch)) return;
      const parsed = paymentHeadDocSchema.safeParse(data);
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

  const nextCursor: PaymentHeadListCursor = {};
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
