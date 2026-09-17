import { createHash } from "node:crypto";

// The canonical normalized-account-identity algorithm (Step 7A section
// 3). Computed ONCE, at Partner Account creation, from whichever
// evidence is strongest at that moment - and never recomputed on a later
// edit. This is deliberate, not an oversight:
//
// - "Account identity must survive handle/display-name changes... do not
//   treat cosmetic display-name changes as a new account" - if identity
//   were recomputed from the current handle on every edit, a rename
//   would silently change which claim the account holds, which is
//   exactly the kind of consequential identity change the spec calls
//   out separately ("transfer is not a casual edit"). Freezing identity
//   at creation and letting handle/profileUrl/platformAccountId remain
//   freely editable as plain metadata afterward satisfies both rules at
//   once: a rename never fragments identity, and an edit never silently
//   reclaims a different identity out from under the account.
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

function normalizePlatform(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePlatformAccountId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeProfileUrl(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}

function normalizeHandle(value: string): string {
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
