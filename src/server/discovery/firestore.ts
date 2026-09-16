import { FieldPath, Filter } from "firebase-admin/firestore";

import { getAdminFirestore } from "@/server/firebase/admin";
import type { ScopeGrant } from "@/server/authz/types";
import {
  leadDocSchema,
  leadRestrictedKycDocSchema,
  partnerAccountDocSchema,
  partnerDocSchema,
  type LeadDoc,
  type LeadRestrictedKycDoc,
  type PartnerAccountDoc,
  type PartnerDoc,
} from "./types";

export const DISCOVERY_COLLECTIONS = {
  leads: "leads",
  leadEvents: "events", // subcollection name under leads/{uid}
  leadRestrictedKyc: "leadRestrictedKyc",
  partners: "partners",
  partnerAccounts: "partnerAccounts",
} as const;

// Bounded pagination default/ceiling - same discipline as
// src/server/authz/firestore.ts's MAX_LIST_PAGE_SIZE.
export const MAX_LEAD_PAGE_SIZE = 100;
export const DEFAULT_LEAD_PAGE_SIZE = 20;

// Firestore's `in` operator caps at 30 values per query - bounded by
// construction, never an unbounded IN list.
const MAX_SCOPE_IN_VALUES = 30;

export function leadsCollection() {
  return getAdminFirestore().collection(DISCOVERY_COLLECTIONS.leads);
}

export function leadEventsCollection(leadUid: string) {
  return leadsCollection().doc(leadUid).collection(DISCOVERY_COLLECTIONS.leadEvents);
}

export function leadRestrictedKycCollection() {
  return getAdminFirestore().collection(DISCOVERY_COLLECTIONS.leadRestrictedKyc);
}

export function partnersCollection() {
  return getAdminFirestore().collection(DISCOVERY_COLLECTIONS.partners);
}

export function partnerAccountsCollection() {
  return getAdminFirestore().collection(DISCOVERY_COLLECTIONS.partnerAccounts);
}

export async function getLeadDocByUid(uid: string): Promise<LeadDoc | null> {
  const snapshot = await leadsCollection().doc(uid).get();
  if (!snapshot.exists) return null;
  const result = leadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Resolves a Lead by its opaque, browser-facing leadRef instead of the
// internal Firestore doc id - same idiom as getUserDocByRef. A tampered
// or made-up token simply matches no document.
export async function getLeadDocByRef(leadRef: string): Promise<LeadDoc | null> {
  const snapshot = await leadsCollection().where("leadRef", "==", leadRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = leadDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export async function getLeadRestrictedKycDoc(leadUid: string): Promise<LeadRestrictedKycDoc | null> {
  const snapshot = await leadRestrictedKycCollection().doc(leadUid).get();
  if (!snapshot.exists) return null;
  const result = leadRestrictedKycDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getPartnerDocByRef(partnerRef: string): Promise<PartnerDoc | null> {
  const snapshot = await partnersCollection().where("partnerRef", "==", partnerRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = partnerDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export async function getPartnerAccountDocByRef(partnerAccountRef: string): Promise<PartnerAccountDoc | null> {
  const snapshot = await partnerAccountsCollection().where("partnerAccountRef", "==", partnerAccountRef).limit(1).get();
  if (snapshot.empty) return null;
  const result = partnerAccountDocSchema.safeParse(snapshot.docs[0]!.data());
  return result.success ? result.data : null;
}

export type LeadMutationResult = { kind: "ok"; doc: LeadDoc } | { kind: "stale" } | { kind: "not_found" };

// Shared transactional "read current, verify optimistic version, apply a
// pure patch, write" primitive - reads before writes (a hard Firestore
// transaction requirement), used by every ordinary field/evidence
// mutation in lead-service.ts/kyc-service.ts so optimistic-concurrency
// enforcement lives in exactly one place. Transitions with extra
// preconditions (lifecycle-service.ts, conversion-service.ts) run their
// own transactions instead, since they need to re-validate more than
// just the version before writing.
export async function runLeadMutation(leadUid: string, expectedVersion: number, mutate: (current: LeadDoc) => LeadDoc): Promise<LeadMutationResult> {
  const db = getAdminFirestore();
  const docRef = leadsCollection().doc(leadUid);

  return db.runTransaction<LeadMutationResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsed = leadDocSchema.safeParse(snap.data());
    if (!parsed.success) return { kind: "not_found" };
    const current = parsed.data;

    if (current.version !== expectedVersion) return { kind: "stale" };

    // Optimistic-concurrency bump lives here, once, rather than in every
    // caller's own `mutate` - a caller only needs to describe WHAT
    // changes, never remember to also bump the version.
    const next = { ...mutate(current), version: current.version + 1 };
    tx.set(docRef, next);
    return { kind: "ok", doc: next };
  });
}

// Opaque to callers - `orderValue` is whichever field the active query
// mode is actually ordered by (createdAt / displayNameLower /
// outreachSummary.nextFollowUpAt, see listLeadDocs) - the client only
// ever echoes it back unchanged, never inspects or constructs it.
export type LeadListCursor = { orderValue: string; uid: string };

export type ListLeadsPage = { leads: LeadDoc[]; nextCursor: LeadListCursor | null };

// Builds the OR-combined scope filter for a non-GLOBAL actor's grants:
// one branch per dimension the actor actually holds (SELF -> ownerUid
// ==, REGION -> region in [...], TEAM -> teamId in [...],
// EXPLICIT_RECORD(lead) -> document id in [...]). Returns null when the
// actor holds none of these - the caller must treat that as "return an
// empty page", never as "no filter" (no missing-scope => global
// fallback).
//
// Combining Filter.or(...) with orderBy(createdAt, documentId) requires
// a composite index per OR branch once deployed to a real (non-emulator)
// Firestore project - documented in firestore.indexes.json at the repo
// root (ownerUid+createdAt, region+createdAt, teamId+createdAt, and the
// lifecycle-filtered variants of each). The local emulator - the only
// thing any test in this repo runs against - does not enforce composite
// indexes at all, so this is undocumented-but-working here and would
// need those indexes deployed before going live.
function buildLeadScopeFilter(actorUid: string, grants: ScopeGrant[]): Filter | null {
  const branches: Filter[] = [];

  if (grants.some((g) => g.type === "SELF")) {
    branches.push(Filter.where("ownerUid", "==", actorUid));
  }

  const regions = [...new Set(grants.filter((g): g is Extract<ScopeGrant, { type: "REGION" }> => g.type === "REGION").map((g) => g.region))].slice(0, MAX_SCOPE_IN_VALUES);
  if (regions.length > 0) branches.push(Filter.where("region", "in", regions));

  const teamIds = [...new Set(grants.filter((g): g is Extract<ScopeGrant, { type: "TEAM" }> => g.type === "TEAM").map((g) => g.teamId))].slice(0, MAX_SCOPE_IN_VALUES);
  if (teamIds.length > 0) branches.push(Filter.where("teamId", "in", teamIds));

  const explicitLeadUids = [
    ...new Set(
      grants
        .filter((g): g is Extract<ScopeGrant, { type: "EXPLICIT_RECORD" }> => g.type === "EXPLICIT_RECORD" && g.resourceType === "lead")
        .map((g) => g.resourceId),
    ),
  ].slice(0, MAX_SCOPE_IN_VALUES);
  if (explicitLeadUids.length > 0) branches.push(Filter.where(FieldPath.documentId(), "in", explicitLeadUids));

  if (branches.length === 0) return null;
  return branches.length === 1 ? branches[0]! : Filter.or(...branches);
}

function readPath(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
}

// Bounded cursor pagination, never a whole-collection fetch, never a
// broad fetch followed by in-memory scope/filter narrowing. `hasGlobal`
// short-circuits to no scope filter at all; otherwise the scope filter
// is pushed into the Firestore query itself via Filter.or (see
// buildLeadScopeFilter). A non-GLOBAL actor with zero relevant grants
// gets an empty page without any Firestore read at all.
//
// Step 6B extends this with real server-side filters (lifecycle,
// region, platform, "assigned to me", name search) plus a "follow-up
// due" view. displayNamePrefix and followUpDue are mutually exclusive
// alternate ORDERING modes, not stackable on top of the default - a
// Firestore range/prefix filter must be the first orderBy field, so
// searching by name orders by name (not recency), and the follow-up
// view orders by due date (not recency) instead of the default
// createdAt-desc ordering. Every mode still combines with the scope
// filter and the plain-equality filters above via Filter.and.
export async function listLeadDocs(options: {
  limit: number;
  cursor?: LeadListCursor;
  actorUid: string;
  grants: ScopeGrant[];
  hasGlobal: boolean;
  lifecycle?: string;
  region?: string;
  platform?: string;
  assignedToMe?: boolean;
  displayNamePrefix?: string;
  followUpDue?: boolean;
}): Promise<ListLeadsPage> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_LEAD_PAGE_SIZE));

  let scopeFilter: Filter | null = null;
  if (!options.hasGlobal) {
    scopeFilter = buildLeadScopeFilter(options.actorUid, options.grants);
    if (!scopeFilter) return { leads: [], nextCursor: null };
  }

  const filters: Filter[] = [];
  if (scopeFilter) filters.push(scopeFilter);
  if (options.lifecycle) filters.push(Filter.where("lifecycle", "==", options.lifecycle));
  if (options.region) filters.push(Filter.where("region", "==", options.region));
  if (options.platform) filters.push(Filter.where("platform", "==", options.platform));
  if (options.assignedToMe) filters.push(Filter.where("ownerUid", "==", options.actorUid));

  let orderField = "createdAt";
  let orderDirection: FirebaseFirestore.OrderByDirection = "desc";
  if (options.displayNamePrefix) {
    orderField = "displayNameLower";
    orderDirection = "asc";
    filters.push(Filter.where("displayNameLower", ">=", options.displayNamePrefix));
    filters.push(Filter.where("displayNameLower", "<", `${options.displayNamePrefix}`));
  } else if (options.followUpDue) {
    orderField = "outreachSummary.nextFollowUpAt";
    orderDirection = "asc";
    filters.push(Filter.where("outreachSummary.nextFollowUpAt", "<=", new Date().toISOString()));
  }

  let query = leadsCollection().orderBy(orderField, orderDirection).orderBy(FieldPath.documentId()).limit(pageSize + 1);
  if (filters.length === 1) query = query.where(filters[0]!);
  else if (filters.length > 1) query = query.where(Filter.and(...filters));
  if (options.cursor) query = query.startAfter(options.cursor.orderValue, options.cursor.uid);

  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const hasMore = snapshot.docs.length > pageSize;

  const leads: LeadDoc[] = [];
  for (const doc of pageDocs) {
    const result = leadDocSchema.safeParse(doc.data());
    if (result.success) leads.push(result.data);
  }

  const last = pageDocs[pageDocs.length - 1];
  const nextCursor = hasMore && last ? { orderValue: String(readPath(last.data() as Record<string, unknown>, orderField) ?? ""), uid: last.id } : null;

  return { leads, nextCursor };
}
