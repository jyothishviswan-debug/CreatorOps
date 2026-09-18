import { createHash } from "node:crypto";

import { normalizePlatformIdentifier } from "@/server/shared/platform";

// The canonical normalized-account-identity algorithm (Step 7A section
// 3, corrected in Step 7A.1). Represents the CURRENT strongest external
// identity evidence available for an account - not a value frozen at
// creation. Step 7A originally froze this permanently at creation, on
// the theory that a handle rename should never fragment identity. That
// protection was real but too broad: when an account was only ever
// identified by a fallback (profile URL or handle, never a stable
// platform id), freezing it meant a legitimate rename left the OLD
// value permanently squatting on a uniqueness claim no one could ever
// release, while the account's own current identity was no longer
// discoverable by anyone matching against its real, current handle.
//
// The durable canonical identity of an account is its own
// partnerAccountRef - never this value. normalizedIdentity is allowed to
// evolve (see partner-account-service.ts's editPartnerAccount, which
// transactionally re-claims the new value and releases the old one) so
// it keeps meaning "the current strongest identity evidence", exactly
// as durable as whatever platform evidence backs it. A stable platform
// id, once set, is NOT allowed to be casually replaced by a different
// one through the ordinary edit path (that IS a consequential,
// identity-sensitive change, distinct from an ordinary rename) - see
// editPartnerAccount's own comment for why that one case is rejected
// rather than evolved.
//
// Priority: a stable platform/channel id is the strongest evidence
// (survives every cosmetic change); a profile URL is next (usually
// embeds or resolves to a stable id); a handle is weakest (the thing
// most likely to change). Platform is always folded into the key so the
// same raw id/handle on two different platforms never collides.
export type IdentityEvidence = {
  platform: string;
  platformAccountId?: string | null;
  profileUrl?: string | null;
  handle?: string | null;
};

// Step 9A.1: extracted to @/server/shared/platform so Campaigns can speak
// the exact same platform-identifier language - re-exported under its
// original local name here so nothing else in this file changes.
const normalizePlatform = normalizePlatformIdentifier;

// Step 12A: exported (previously module-private) so Analytics' own
// Partner Account fallback-scan matcher (see
// @/server/analytics/partner-account-matcher.ts) can normalize an
// ALREADY-STORED account's own handle/profileUrl/platformAccountId
// fields using the exact same per-field algorithm computeNormalizedIdentity
// uses internally, rather than duplicating this logic a second time
// anywhere else. Purely additive - nothing about the functions themselves
// changed, and every existing caller of computeNormalizedIdentity/
// claimIdFor is unaffected.
export function normalizePlatformAccountId(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeProfileUrl(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}

export function normalizeHandle(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "");
}

// Returns null only when NO identity evidence was supplied at all - the
// caller must treat that as invalid input, never as "assign no identity".
export function computeNormalizedIdentity(evidence: IdentityEvidence): string | null {
  const platform = normalizePlatform(evidence.platform);
  if (!platform) return null;

  if (evidence.platformAccountId && evidence.platformAccountId.trim()) {
    return `${platform}:id:${normalizePlatformAccountId(evidence.platformAccountId)}`;
  }
  if (evidence.profileUrl && evidence.profileUrl.trim()) {
    return `${platform}:url:${normalizeProfileUrl(evidence.profileUrl)}`;
  }
  if (evidence.handle && evidence.handle.trim()) {
    return `${platform}:handle:${normalizeHandle(evidence.handle)}`;
  }
  return null;
}

// Firestore document ids reject "/", have a length ceiling, and must be
// valid UTF-8 - a raw normalizedIdentity (which can embed an arbitrary
// URL) is not safe to use directly as one. A deterministic hash is: same
// input always claims the same document, with no character-set or
// length hazard.
export function claimIdFor(normalizedIdentity: string): string {
  return createHash("sha256").update(normalizedIdentity).digest("hex");
}
