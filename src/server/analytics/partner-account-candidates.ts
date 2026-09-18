// Step 12B: a minimal, new, bounded/scoped/authorized Partner Account
// search, built ONLY for the Explorer's channel-record match-correction
// dialog (AnalyticsResolveMatchDialog.tsx). No cross-partner, cross-
// platform Partner Account search endpoint already existed anywhere in
// this codebase before this file (confirmed by searching
// src/server/partners/** and src/app/api/partners/** - listPartnerAccounts
// only ever lists accounts under one already-known partnerRef; the only
// existing "search" precedent is Partners' own bounded
// searchPartnerOwnerCandidates in user-picker.ts, over the unrelated
// users collection - this file mirrors that same bounded/gated idiom,
// applied to Partner Accounts instead).
//
// Deliberately reuses partners' OWN exported read primitives
// (partnerAccountsCollection, getPartnerDocByRef, requirePartnerInScope)
// rather than duplicating them - src/server/partners/firestore.ts and
// partners-gate.ts are read from, never edited (both are protected/
// frozen for this step). Gated by Analytics' OWN manage_analytics_data
// action (requireAnalyticsManageAccess) - the same gate that already
// governs the resolve-match action this search exists to feed - not by
// any Partners-side action, since this is an Analytics-workflow-internal
// lookup, not a general Partner Account directory browse.
//
// Bounded, honest limitations (disclosed, not hidden): fetches at most
// FETCH_WINDOW candidate docs (a single-field platform equality filter,
// or an unfiltered bounded scan when no platform is given - deliberately
// avoiding any NEW Firestore composite index, since firestore.indexes.json
// is frozen/protected for this step), then filters by query text and by
// the actor's own scope (via each candidate's OWNING Partner) in memory.
// A match that exists outside this bounded window will not surface -
// same "bounded, not exhaustive" discipline as every other Analytics
// bounded read in this step (see overview-service.ts's own comment).
import { z } from "zod";

import { getPartnerDocsByRefs, partnerAccountsCollection } from "@/server/partners/firestore";
import { requirePartnerInScope } from "@/server/partners/partners-gate";
import { partnerAccountDocSchema, type PartnerAccountDoc, type PartnerDoc } from "@/server/partners/types";
import type { ActorContext } from "@/server/authz/types";

import { requireAnalyticsManageAccess } from "./analytics-gate";
import { analyticsInvalidInputResult, analyticsUnauthorizedResult, type AnalyticsServiceResult } from "./types";

const FETCH_WINDOW = 100;
const MAX_RESULTS = 25;

const searchInputSchema = z.object({
  query: z.string().max(200).optional(),
  platform: z.string().min(1).max(60).optional(),
  limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
});
export type SearchAnalyticsPartnerAccountCandidatesInput = z.input<typeof searchInputSchema>;

// A safe, minimal candidate row - never a raw ref rendered as prose
// (partnerAccountRef only travels as an opaque id the caller submits
// back, same discipline as every other picker in this app), never an
// internal uid.
export type AnalyticsPartnerAccountCandidateDto = {
  partnerAccountRef: string;
  platform: string;
  label: string;
  partnerDisplayName: string;
};

function candidateLabel(account: PartnerAccountDoc): string {
  return account.displayName ?? account.handle ?? account.platformAccountId ?? "Unnamed account";
}

function matchesQuery(account: PartnerAccountDoc, needle: string): boolean {
  if (needle.length === 0) return true;
  const haystack = [account.displayName, account.handle, account.normalizedIdentity].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(needle);
}

export async function searchAnalyticsPartnerAccountCandidates(actor: ActorContext | null, rawInput: unknown): Promise<AnalyticsServiceResult<AnalyticsPartnerAccountCandidateDto[]>> {
  const gate = await requireAnalyticsManageAccess(actor);
  if (!gate.ok) return analyticsUnauthorizedResult(gate.reason);

  const parsed = searchInputSchema.safeParse(rawInput);
  if (!parsed.success) return analyticsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const { query, platform, limit } = parsed.data;

  // Single equality filter only (or none) - never combined with an
  // orderBy on a different field, so this never needs a new composite
  // Firestore index.
  const base = platform ? partnerAccountsCollection().where("platform", "==", platform) : partnerAccountsCollection();
  const snapshot = await base.limit(FETCH_WINDOW).get();

  const needle = (query ?? "").trim().toLowerCase();
  const accounts: PartnerAccountDoc[] = [];
  for (const doc of snapshot.docs) {
    const parsedDoc = partnerAccountDocSchema.safeParse(doc.data());
    if (!parsedDoc.success) continue;
    if (parsedDoc.data.status !== "ACTIVE") continue;
    if (!matchesQuery(parsedDoc.data, needle)) continue;
    accounts.push(parsedDoc.data);
  }

  const partnerRefs = [...new Set(accounts.map((a) => a.partnerRef))];
  const partnerDocs = await getPartnerDocsByRefs(partnerRefs);

  const inScope: { account: PartnerAccountDoc; partner: PartnerDoc }[] = [];
  for (const account of accounts) {
    const partner = partnerDocs.get(account.partnerRef);
    if (!partner) continue;
    const scopeCheck = await requirePartnerInScope(actor!, partner);
    if (!scopeCheck.ok) continue;
    inScope.push({ account, partner });
  }

  const results = inScope.slice(0, limit ?? 10).map(({ account, partner }) => ({
    partnerAccountRef: account.partnerAccountRef,
    platform: account.platform,
    label: candidateLabel(account),
    partnerDisplayName: partner.displayName,
  }));

  return { ok: true, data: results };
}
