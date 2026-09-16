// Validates a post-sign-in redirect target that came from an untrusted
// source (a URL query param), so a crafted link like
// /sign-in?redirect=https://evil.example or //evil.example can never send
// a signed-in user off-site. Only a same-origin, single-leading-slash path
// is accepted; anything else falls back to the default.
const DEFAULT_REDIRECT = "/dashboard";

export function getSafeRedirectPath(candidate: string | null | undefined, fallback: string = DEFAULT_REDIRECT): string {
  if (!candidate) return fallback;
  if (!candidate.startsWith("/")) return fallback;
  if (candidate.startsWith("//")) return fallback;
  if (candidate.includes("://")) return fallback;
  if (candidate === "/sign-in" || candidate.startsWith("/sign-in/") || candidate.startsWith("/sign-in?")) return fallback;
  return candidate;
}
