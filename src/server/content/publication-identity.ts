// Step 11A: publication URL normalization - no prior repo precedent
// existed beyond Partner Account's pure `https://`-only shape validation
// (zero normalization). Deliberately conservative: lowercase the host,
// strip a single trailing slash from the path, drop the fragment, and
// keep the query string exactly as supplied (never stripping tracking
// params - that would be inventing unapproved normalization behavior).
// An unparseable value normalizes to its own trimmed, lowercased string
// as a safe fallback - never thrown, since this must never block a
// public submission with an unhandled exception.
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

// The identity key claimed transactionally by the public submit flow
// (see external-submission-service.ts's submitExternalLinks) -
// namespaced per platform so the same normalized URL under a different
// platform is never treated as the same identity.
//
// Step 11A.1: publicationContentIdIdentityKey is retired - platformContentId
// no longer legitimately exists anywhere on the collected data shape (the
// public form never collects it), so a platform-content-id identity claim
// is dead code and has been removed rather than left unused.
export function publicationUrlIdentityKey(platform: string, normalizedUrl: string): string {
  return `url:${platform}:${normalizedUrl}`;
}
