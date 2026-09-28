// Production hardening (base spec section 21 - rate limiting / abuse control): a shared,
// application-level abuse-throttling abstraction for expensive/abuse-sensitive endpoints, promoted
// from the ONE existing rate limiter in this codebase (src/server/assignments/rate-limit.ts, built
// for the public external-submission routes under Step 10A section 16's own allowance: "if the
// current stack has no reusable rate limiter, implement a minimal bounded local-safe defense or
// document the deferred production edge rather than pretending it is solved"). Left untouched -
// same tested sliding-window algorithm, generalized here so OTHER abuse-sensitive endpoints
// (Reports runs/artifacts, Import, Export, OCR/extraction, admin diagnostics, notification mutation
// bursts) can reuse it instead of re-deriving their own copy.
//
// What this is: an in-process, per-server-instance sliding-window counter - bounded so its own
// tracking Map can never grow without limit across a long server lifetime. What this is NOT: a
// production defense. It resets on every server restart, shares no state across multiple server
// instances, and is trivially bypassed by rotating identity/source. A real production deployment
// needs shared-state rate limiting (Redis, Upstash, or an edge/WAF layer - see
// docs/PRODUCTION_HARDENING.md's managed-edge design) - out of scope for local/emulator-only
// verification, and deliberately not pretended to be solved here. The `RateLimiter` interface below
// is the seam a real provider plugs into without changing any call site.

export type RateLimiter = {
  // Returns true if this attempt is allowed (and records it); false if the caller is over the
  // limit for this key/window. Never throws - a rate limiter that can fail closed on its own
  // internal error would turn an abuse-control feature into an availability bug.
  checkAndRecord(key: string, maxAttempts: number, windowMs: number): boolean;
};

const MAX_TRACKED_KEYS = 5000;

class InMemorySlidingWindowRateLimiter implements RateLimiter {
  private readonly attempts = new Map<string, number[]>();

  checkAndRecord(key: string, maxAttempts: number, windowMs: number): boolean {
    const now = Date.now();
    const existing = this.attempts.get(key) ?? [];
    const recent = existing.filter((t) => now - t < windowMs);

    if (recent.length >= maxAttempts) {
      this.attempts.set(key, recent);
      return false;
    }

    recent.push(now);
    this.attempts.set(key, recent);

    if (this.attempts.size > MAX_TRACKED_KEYS) {
      const oldestKey = this.attempts.keys().next().value;
      if (oldestKey !== undefined) this.attempts.delete(oldestKey);
    }

    return true;
  }
}

// One process-wide instance, same lifetime discipline as the existing assignments limiter's own
// module-level Map - deliberately not per-request.
const defaultLimiter: RateLimiter = new InMemorySlidingWindowRateLimiter();

export function getDefaultRateLimiter(): RateLimiter {
  return defaultLimiter;
}

// Best-effort caller IP - never used for any authorization decision, only as a coarse
// abuse-throttling dimension when no authenticated actor is available yet.
export function requestIpKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]!.trim();
  return "unknown";
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

// The one call shape every route-level rate-limit check in this codebase should use: a scope tag
// (so different endpoints never share a bucket by accident), a dimension key (an actor uid/userRef
// when authenticated, requestIpKey(request) otherwise - callers decide, this module never guesses),
// a max-attempts count and a window. Returns a safe retry-after hint (base spec section 21's "safe
// retry headers") - always the FULL window, a deliberately simple, conservative estimate rather than
// computing the exact remaining time of the oldest tracked attempt.
export function checkRateLimit(scope: string, dimensionKey: string, maxAttempts: number, windowMs: number, limiter: RateLimiter = defaultLimiter): RateLimitDecision {
  const key = `${scope}:${dimensionKey}`;
  const allowed = limiter.checkAndRecord(key, maxAttempts, windowMs);
  return allowed ? { allowed: true } : { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
}
