import { claimIdFor, computeNormalizedIdentity, normalizeHandle, normalizeProfileUrl, normalizePlatformAccountId } from "@/server/partners/identity";
import { getPartnerAccountDocByUid, getPartnerAccountIdentityClaim, getPartnerDocByRef, partnerAccountsCollection } from "@/server/partners/firestore";
import type { PartnerAccountDoc } from "@/server/partners/types";

import type { AnalyticsMatchEvidence, AnalyticsMatchState } from "./types";

// Step 12A section 12: Partner Account matching - a real, tested source
// of AMBIGUOUS (unlike Content matching - see content-matcher.ts's own
// header comment), because partnerAccountIdentityClaims holds exactly ONE
// key per account (whatever evidence was strongest AT CREATION), so a
// source row supplying only a WEAKER evidence dimension than the account
// was originally keyed with would legitimately miss via a naive single
// claim lookup - the fallback scan below exists specifically to still
// find it, and can genuinely surface more than one distinct account.
//
// FAST PATH: for each evidence dimension the row actually supplies
// (platformAccountId, profileUrl, handle - tried in that priority order,
// matching computeNormalizedIdentity's own priority), compute the
// single-dimension normalized identity exactly as the account itself
// would have been keyed had that been its sole/strongest evidence, and
// try the claim lookup. Every dimension the row supplies is tried (not
// just the first that resolves) - this is what lets the fast path alone
// surface a genuine ambiguity when two of the row's own supplied
// dimensions each independently claim a DIFFERENT account.
//
// FALLBACK SCAN: only when the fast path found zero distinct accounts -
// one bounded `where("platform","==",...).limit(MAX_...)` query, each
// returned account's OWN stored handle/profileUrl/platformAccountId
// normalized with the exact same per-field normalizers identity.ts uses
// internally, checked against the row's own supplied value for that SAME
// dimension. displayName is NEVER used as a matching dimension, anywhere
// in this file.
export const MAX_PARTNER_ACCOUNT_FALLBACK_SCAN = 200;

export type PartnerAccountMatchResult = {
  matchState: AnalyticsMatchState;
  matchEvidence: AnalyticsMatchEvidence;
  matchedPartnerRef: string | null;
  matchedPartnerAccountRef: string | null;
  // Scope projection, denormalized from the matched account's OWNING
  // PARTNER (see types.ts's own comment on
  // analyticsChannelSourceRecordDocSchema) - null/empty for anything not
  // MATCHED.
  ownerUid: string | null;
  regionIds: string[];
  teamIds: string[];
};

export type ChannelMatchRow = {
  platform: string;
  platformAccountId: string | null;
  profileUrl: string | null;
  handle: string | null;
};

async function fastPathDistinctAccountUids(row: ChannelMatchRow): Promise<Set<string>> {
  const found = new Set<string>();

  const attempts: Array<{ platformAccountId?: string; profileUrl?: string; handle?: string }> = [];
  if (row.platformAccountId) attempts.push({ platformAccountId: row.platformAccountId });
  if (row.profileUrl) attempts.push({ profileUrl: row.profileUrl });
  if (row.handle) attempts.push({ handle: row.handle });

  for (const attempt of attempts) {
    const normalized = computeNormalizedIdentity({ platform: row.platform, ...attempt });
    if (!normalized) continue;
    const claim = await getPartnerAccountIdentityClaim(claimIdFor(normalized));
    if (claim) found.add(claim.partnerAccountUid);
  }

  return found;
}

async function fallbackScanDistinctAccountUids(row: ChannelMatchRow): Promise<Set<string>> {
  const found = new Set<string>();
  const snapshot = await partnerAccountsCollection().where("platform", "==", row.platform).limit(MAX_PARTNER_ACCOUNT_FALLBACK_SCAN).get();

  for (const doc of snapshot.docs) {
    const account = doc.data() as PartnerAccountDoc;
    if (row.platformAccountId && account.platformAccountId && normalizePlatformAccountId(row.platformAccountId) === normalizePlatformAccountId(account.platformAccountId)) {
      found.add(account.uid);
      continue;
    }
    if (row.profileUrl && account.profileUrl && normalizeProfileUrl(row.profileUrl) === normalizeProfileUrl(account.profileUrl)) {
      found.add(account.uid);
      continue;
    }
    if (row.handle && account.handle && normalizeHandle(row.handle) === normalizeHandle(account.handle)) {
      found.add(account.uid);
    }
    // displayName is deliberately never checked - not a matching
    // dimension anywhere in this codebase's Partner Account identity
    // model.
  }

  return found;
}

function unmatched(tier: "identity_claim" | "bounded_scan" | "none", value: string | null, reasonCode: string, candidateCount = 0): PartnerAccountMatchResult {
  return { matchState: "UNMATCHED", matchEvidence: { tier, value, reasonCode, candidateCount }, matchedPartnerRef: null, matchedPartnerAccountRef: null, ownerUid: null, regionIds: [], teamIds: [] };
}

export async function matchPartnerAccountSourceRow(row: ChannelMatchRow): Promise<PartnerAccountMatchResult> {
  if (!row.platformAccountId && !row.profileUrl && !row.handle) {
    return unmatched("none", null, "NO_MATCHING_KEY_SUPPLIED");
  }

  const fastPathHits = await fastPathDistinctAccountUids(row);
  const usedFallback = fastPathHits.size === 0;
  const distinctUids = fastPathHits.size > 0 ? fastPathHits : await fallbackScanDistinctAccountUids(row);

  const tier: "identity_claim" | "bounded_scan" = usedFallback ? "bounded_scan" : "identity_claim";
  const value = row.platformAccountId ?? row.profileUrl ?? row.handle ?? null;

  if (distinctUids.size === 0) {
    return unmatched(tier, value, usedFallback ? "NO_ACCOUNT_FOUND_IN_BOUNDED_SCAN" : "NO_CLAIM_FOUND");
  }

  if (distinctUids.size > 1) {
    return {
      matchState: "AMBIGUOUS",
      matchEvidence: { tier, value, reasonCode: "MULTIPLE_DISTINCT_ACCOUNTS_MATCHED", candidateCount: distinctUids.size },
      matchedPartnerRef: null,
      matchedPartnerAccountRef: null,
      ownerUid: null,
      regionIds: [],
      teamIds: [],
    };
  }

  const [onlyUid] = distinctUids;
  const account = await getPartnerAccountDocByUid(onlyUid!);
  if (!account) {
    return unmatched(tier, value, "MATCHED_ACCOUNT_NOT_FOUND", 1);
  }
  const partner = await getPartnerDocByRef(account.partnerRef);

  return {
    matchState: "MATCHED",
    matchEvidence: { tier, value, reasonCode: null, candidateCount: 1 },
    matchedPartnerRef: account.partnerRef,
    matchedPartnerAccountRef: account.partnerAccountRef,
    ownerUid: partner?.ownerUid ?? null,
    regionIds: partner?.regionIds ?? [],
    teamIds: partner?.teamIds ?? [],
  };
}
