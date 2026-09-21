import { createHash } from "node:crypto";

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
  agreementClaimDocSchema,
  agreementEventSchema,
  agreementHeadDocSchema,
  agreementVersionDocSchema,
  contractArtifactDocSchema,
  extractionRunDocSchema,
  restrictedExtractionDocSchema,
  type AgreementClaimDoc,
  type AgreementCounterpartyInput,
  type AgreementEvent,
  type AgreementHeadDoc,
  type AgreementVersionDoc,
  type ContractArtifactDoc,
  type ExtractionRunDoc,
  type RestrictedExtractionDoc,
} from "./types";

// Step 14A: collection accessors + parse-on-read/parse-on-write helpers for the Finance
// Agreements domain.
//
// There is deliberately NO delete anywhere in this module - not a helper, not a batch,
// not a transaction delete. History is preserved; an Agreement is ended, never removed.
// (A static boundary test enforces this. Test/dev cleanup lives in the emulator-reset
// utility and in test files, never here.)

export const FINANCE_AGREEMENT_COLLECTIONS = {
  financeAgreements: "financeAgreements",
  versions: "versions", // subcollection under financeAgreements/{agreementRef}
  events: "events", // subcollection under financeAgreements/{agreementRef}
  extractionRuns: "extractionRuns", // subcollection under financeAgreements/{agreementRef}
  financeAgreementClaims: "financeAgreementClaims",
  financeContractArtifacts: "financeContractArtifacts",
  financeAgreementRestrictedExtractions: "financeAgreementRestrictedExtractions",
} as const;

export const MAX_AGREEMENT_VERSION_SUMMARIES = 50;
export const DEFAULT_AGREEMENT_EVENT_PAGE = 50;
export const MAX_AGREEMENT_EVENT_PAGE = 100;

export function financeAgreementsCollection() {
  return getAdminFirestore().collection(FINANCE_AGREEMENT_COLLECTIONS.financeAgreements);
}

export function financeAgreementVersionsCollection(agreementRef: string) {
  return financeAgreementsCollection().doc(agreementRef).collection(FINANCE_AGREEMENT_COLLECTIONS.versions);
}

export function financeAgreementEventsCollection(agreementRef: string) {
  return financeAgreementsCollection().doc(agreementRef).collection(FINANCE_AGREEMENT_COLLECTIONS.events);
}

export function financeAgreementExtractionRunsCollection(agreementRef: string) {
  return financeAgreementsCollection().doc(agreementRef).collection(FINANCE_AGREEMENT_COLLECTIONS.extractionRuns);
}

export function financeAgreementClaimsCollection() {
  return getAdminFirestore().collection(FINANCE_AGREEMENT_COLLECTIONS.financeAgreementClaims);
}

export function financeContractArtifactsCollection() {
  return getAdminFirestore().collection(FINANCE_AGREEMENT_COLLECTIONS.financeContractArtifacts);
}

export function financeAgreementRestrictedExtractionsCollection() {
  return getAdminFirestore().collection(FINANCE_AGREEMENT_COLLECTIONS.financeAgreementRestrictedExtractions);
}

// Version doc ids are the plain integer as a string ("1", "2", ...) - the deterministic id
// makes "exactly one version N" a document-existence fact (tx.create fails on a duplicate).
// Ordering never relies on the id (it would sort "10" before "2"); list order is always the
// numeric `version` field.
export function versionDocId(version: number): string {
  return String(version);
}

// Deterministic idempotency-claim id: sha256(actorUid|clientRequestId). Two different actors
// can reuse the same clientRequestId without colliding, and the id never reveals either value.
export function agreementClaimId(actorUid: string, clientRequestId: string): string {
  return createHash("sha256").update(`${actorUid}|${clientRequestId}`).digest("hex");
}

// Canonical fingerprint of the create-draft payload (the counterparty the client named, with
// account refs sorted/deduped), stored on the claim so a retry that CHANGES the payload can be
// reported as a conflict instead of silently returning a different Agreement.
export function createDraftInputFingerprint(counterparty: AgreementCounterpartyInput): string {
  const canonical =
    counterparty.type === "PARTNER"
      ? { type: "PARTNER", partnerRef: counterparty.partnerRef, partnerAccountRefs: [...new Set(counterparty.partnerAccountRefs ?? [])].sort() }
      : { type: "VENDOR", vendorRef: counterparty.vendorRef };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// --- Reads: safeParse, null on missing or malformed ------------------------------------------------------------------
export async function getAgreementHeadDoc(agreementRef: string): Promise<AgreementHeadDoc | null> {
  const snapshot = await financeAgreementsCollection().doc(agreementRef).get();
  if (!snapshot.exists) return null;
  const result = agreementHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getAgreementVersionDoc(agreementRef: string, version: number): Promise<AgreementVersionDoc | null> {
  const snapshot = await financeAgreementVersionsCollection(agreementRef).doc(versionDocId(version)).get();
  if (!snapshot.exists) return null;
  const result = agreementVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Bounded, newest-first list of one Agreement's versions (by the numeric `version` field - a
// single-field index, no composite needed).
export async function listAgreementVersionDocs(agreementRef: string, limit = MAX_AGREEMENT_VERSION_SUMMARIES): Promise<{ versions: AgreementVersionDoc[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_AGREEMENT_VERSION_SUMMARIES));
  const snapshot = await financeAgreementVersionsCollection(agreementRef)
    .orderBy("version", "desc")
    .limit(bound + 1)
    .get();

  const versions: AgreementVersionDoc[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = agreementVersionDocSchema.safeParse(doc.data());
    if (parsed.success) versions.push(parsed.data);
  }
  return { versions, hasMore: snapshot.docs.length > bound };
}

// Bounded, newest-first page of one Agreement's audit events (a single-field orderBy on
// `createdAt`, served by the automatic index).
export async function listAgreementEventDocs(agreementRef: string, limit = DEFAULT_AGREEMENT_EVENT_PAGE): Promise<{ events: AgreementEvent[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_AGREEMENT_EVENT_PAGE));
  const snapshot = await financeAgreementEventsCollection(agreementRef)
    .orderBy("createdAt", "desc")
    .limit(bound + 1)
    .get();

  const events: AgreementEvent[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = agreementEventSchema.safeParse(doc.data());
    if (parsed.success) events.push(parsed.data);
  }
  return { events, hasMore: snapshot.docs.length > bound };
}

export async function getAgreementClaimDoc(claimId: string): Promise<AgreementClaimDoc | null> {
  const snapshot = await financeAgreementClaimsCollection().doc(claimId).get();
  if (!snapshot.exists) return null;
  const result = agreementClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getContractArtifactDoc(artifactRef: string): Promise<ContractArtifactDoc | null> {
  const snapshot = await financeContractArtifactsCollection().doc(artifactRef).get();
  if (!snapshot.exists) return null;
  const result = contractArtifactDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getExtractionRunDoc(agreementRef: string, runRef: string): Promise<ExtractionRunDoc | null> {
  const snapshot = await financeAgreementExtractionRunsCollection(agreementRef).doc(runRef).get();
  if (!snapshot.exists) return null;
  const result = extractionRunDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// SERVER-ONLY: callers must have passed requireContractSensitiveAccess (and, for identity
// values, requireIdentitySensitiveAccess) before reading this.
export async function getRestrictedExtractionDoc(runRef: string): Promise<RestrictedExtractionDoc | null> {
  const snapshot = await financeAgreementRestrictedExtractionsCollection().doc(runRef).get();
  if (!snapshot.exists) return null;
  const result = restrictedExtractionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// --- In-transaction reads (Firestore requires every read before any write) ---------------------------------------------
export async function txGetAgreementHead(tx: FirebaseFirestore.Transaction, agreementRef: string): Promise<AgreementHeadDoc | null> {
  const snapshot = await tx.get(financeAgreementsCollection().doc(agreementRef));
  if (!snapshot.exists) return null;
  const result = agreementHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function txGetAgreementVersion(tx: FirebaseFirestore.Transaction, agreementRef: string, version: number): Promise<AgreementVersionDoc | null> {
  const snapshot = await tx.get(financeAgreementVersionsCollection(agreementRef).doc(versionDocId(version)));
  if (!snapshot.exists) return null;
  const result = agreementVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function txGetAgreementClaim(tx: FirebaseFirestore.Transaction, claimId: string): Promise<AgreementClaimDoc | null> {
  const snapshot = await tx.get(financeAgreementClaimsCollection().doc(claimId));
  if (!snapshot.exists) return null;
  const result = agreementClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// --- In-transaction writes: parsed on WRITE, so an invalid doc can never be persisted ------------------------------------
// `create` variants fail the transaction if the doc already exists (the concurrency
// guarantee for "exactly one head / claim / version N"); `set` variants replace a doc the
// transaction has just read and re-validated.
export function txCreateAgreementHead(tx: FirebaseFirestore.Transaction, head: AgreementHeadDoc): void {
  tx.create(financeAgreementsCollection().doc(head.agreementRef), agreementHeadDocSchema.parse(head));
}

export function txSetAgreementHead(tx: FirebaseFirestore.Transaction, head: AgreementHeadDoc): void {
  tx.set(financeAgreementsCollection().doc(head.agreementRef), agreementHeadDocSchema.parse(head));
}

export function txCreateAgreementVersion(tx: FirebaseFirestore.Transaction, version: AgreementVersionDoc): void {
  tx.create(financeAgreementVersionsCollection(version.agreementRef).doc(versionDocId(version.version)), agreementVersionDocSchema.parse(version));
}

export function txSetAgreementVersion(tx: FirebaseFirestore.Transaction, version: AgreementVersionDoc): void {
  tx.set(financeAgreementVersionsCollection(version.agreementRef).doc(versionDocId(version.version)), agreementVersionDocSchema.parse(version));
}

export function txCreateAgreementClaim(tx: FirebaseFirestore.Transaction, claimId: string, claim: AgreementClaimDoc): void {
  tx.create(financeAgreementClaimsCollection().doc(claimId), agreementClaimDocSchema.parse(claim));
}

export function txCreateContractArtifact(tx: FirebaseFirestore.Transaction, artifact: ContractArtifactDoc): void {
  tx.create(financeContractArtifactsCollection().doc(artifact.artifactRef), contractArtifactDocSchema.parse(artifact));
}

export function txCreateExtractionRun(tx: FirebaseFirestore.Transaction, run: ExtractionRunDoc): void {
  tx.create(financeAgreementExtractionRunsCollection(run.agreementRef).doc(run.runRef), extractionRunDocSchema.parse(run));
}

export function txCreateRestrictedExtraction(tx: FirebaseFirestore.Transaction, doc: RestrictedExtractionDoc): void {
  tx.create(financeAgreementRestrictedExtractionsCollection().doc(doc.runRef), restrictedExtractionDocSchema.parse(doc));
}

// --- Scoped head list (Step 14B workspace) --------------------------------------------------------------------------------
// Bounded, scope-FIRST cursor pagination over Agreement heads, mirroring listPartnerReviewHeadDocs. Scope is decomposed into
// independent, individually production-valid branches - SELF via ownerUid, REGION / TEAM via array-contains-any on the head's
// point-in-time scope snapshot, PARTNER-type / EXPLICIT partner grants via `partnerUid in [...]`, EXPLICIT vendor grants via
// `vendorUid in [...]` - each paginated on its own and merged by (updatedAt desc, doc id). Lower-priority branches exclude what
// a higher-priority one already surfaces, so a head is only ever produced by one branch. The snapshot only decides what is
// READ; the caller re-verifies every surfaced head against its LIVE Partner / Vendor. No business filter is pushed to
// Firestore (lifecycle / type / search / period / discrepancy are in-memory over the bounded set), so the composite index set
// stays at exactly the five scope shapes below.
export const MAX_AGREEMENT_HEAD_PAGE_SIZE = 100;
const MAX_SCOPE_IN_VALUES = 30;

export type AgreementHeadListCursor = CompoundListCursor;
export type ListAgreementHeadsPage = { heads: AgreementHeadDoc[]; nextCursor: AgreementHeadListCursor | null };
export type AgreementHeadListQueryOptions = { actorUid: string; grants: ScopeGrant[]; hasGlobal: boolean };

function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

export function planAgreementHeadListQuery(options: AgreementHeadListQueryOptions): { plan: ListQueryPlan; orderField: string; orderDirection: SortDirection } {
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
  // PARTNER grants name a Partner uid; EXPLICIT_RECORD grants with resourceType "partner" do too (both honored by isPartnerDocInScope).
  const grantedPartnerUids = [
    ...new Set([
      ...options.grants.filter((g): g is Extract<ScopeGrant, { type: "PARTNER" }> => g.type === "PARTNER").map((g) => g.partnerId),
      ...options.grants.filter((g): g is Extract<ScopeGrant, { type: "EXPLICIT_RECORD" }> => g.type === "EXPLICIT_RECORD" && g.resourceType === "partner").map((g) => g.resourceId),
    ]),
  ].slice(0, MAX_SCOPE_IN_VALUES);
  // A Vendor is reachable by an explicit vendor record grant (never through a linked Partner - see isVendorDocInScope).
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

export async function listAgreementHeadDocs(options: AgreementHeadListQueryOptions & { limit: number; cursor?: AgreementHeadListCursor }): Promise<ListAgreementHeadsPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_AGREEMENT_HEAD_PAGE_SIZE));
  const { plan, orderField, orderDirection } = planAgreementHeadListQuery(options);
  assertProductionValidPlan(plan);
  if (plan.branches.length === 0) return { heads: [], nextCursor: null };

  const collection = financeAgreementsCollection();
  const cursorIn = options.cursor ?? {};
  const branchBatches: Array<{ name: string; items: MergeCandidate<AgreementHeadDoc>[] }> = [];
  const nextCursorBuilders: Array<(consumed: number) => [string, BranchCursorState] | null> = [];

  for (const branch of plan.branches) {
    if (branch.kind !== "firestore-query") continue;

    const previous = cursorIn[branch.name];
    if (previous && "exhausted" in previous) continue;
    const queryCursor = previous && "orderValue" in previous ? previous : undefined;

    const { docs: rawDocs, hasMoreInBranch } = await executeFirestoreBranch(collection, branch, queryCursor, pageSize);
    const survivorRawIndexes: number[] = [];
    const survivors: MergeCandidate<AgreementHeadDoc>[] = [];
    rawDocs.forEach((doc, rawIndex) => {
      const data = doc.data();
      if (!passesBranchPostFilters(data, branch)) return;
      const parsed = agreementHeadDocSchema.safeParse(data);
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

  const nextCursor: AgreementHeadListCursor = {};
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
