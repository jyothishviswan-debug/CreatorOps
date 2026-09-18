// Step 10A section 16's own allowance: "if the current stack has no
// reusable rate limiter, implement a minimal bounded local-safe defense
// or document the deferred production edge rather than pretending it is
// solved." Confirmed by a repo-wide search: there is no rate-limiting
// infrastructure anywhere in this codebase.
//
// This is exactly that minimal defense and nothing more - an in-process,
// per-server-instance sliding-window counter, used only by the public
// external-submission routes (src/app/api/public/submissions/[token]).
// It is NOT a production defense: it resets on every server restart,
// shares no state across multiple server instances, and is trivially
// bypassed by rotating source IPs. A real production deployment needs
// shared-state rate limiting (e.g. Redis, or an edge/WAF layer like Cloud
// Armor) - out of scope for this local/emulator-only build, and
// deliberately not pretended to be solved here.
const attempts = new Map<string, number[]>();

// Bounded so this Map itself can never grow without limit across a long
// server lifetime - a crude but sufficient local safeguard, evaluated
// lazily rather than via a scheduled job (Step 10A section 11's "no
// scheduled cleanup as canonical security" applies here too, even though
// this isn't a security boundary - just a memory bound).
const MAX_TRACKED_KEYS = 5000;

export function checkAndRecordAttempt(key: string, maxAttempts: number, windowMs: number): boolean {
  const now = Date.now();
  const existing = attempts.get(key) ?? [];
  const recent = existing.filter((t) => now - t < windowMs);

  if (recent.length >= maxAttempts) {
    attempts.set(key, recent);
    return false;
  }

  recent.push(now);
  attempts.set(key, recent);

  if (attempts.size > MAX_TRACKED_KEYS) {
    const oldestKey = attempts.keys().next().value;
    if (oldestKey !== undefined) attempts.delete(oldestKey);
  }

  return true;
}

// Best-effort caller IP for the rate-limit key - never used for any
// authorization decision, only as a coarse abuse-throttling dimension.
export function requestIpKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]!.trim();
  return "unknown";
}
