// Step 11A: publication URL normalization - no prior repo precedent
// existed beyond Partner Account's pure `https://`-only shape validation
// (zero normalization). Deliberately conservative: lowercase the host,
// strip a single trailing slash from the path, drop the fragment, and
// keep the query string exactly as supplied (never stripping tracking
// params - that would be inventing unapproved normalization behavior).
// An unparseable value normalizes to its own trimmed, lowercased string
// as a safe fallback - never thrown, since this must never block a
// staff-facing write with an unhandled exception.
export function normalizeContentUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    url.pathname = path;
    return url.toString();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

// The identity keys claimed transactionally by content-lifecycle-
// service.ts's addPublicationEvidence - namespaced per platform so the
// same normalized URL/id under a different platform is never treated as
// the same identity. platformContentId is NEVER inferred from a URL
// (Step 11A's own explicit rule) - only ever used here when staff
// supplied it directly.
export function publicationUrlIdentityKey(platform: string, normalizedUrl: string): string {
  return `url:${platform}:${normalizedUrl}`;
}

export function publicationContentIdIdentityKey(platform: string, platformContentId: string): string {
  return `pcid:${platform}:${platformContentId}`;
}
