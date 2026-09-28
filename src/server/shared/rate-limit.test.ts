import { describe, expect, it } from "vitest";

import { checkRateLimit, getDefaultRateLimiter, requestIpKey, type RateLimiter } from "./rate-limit";

// Production hardening (base spec section 21/40 - rate limiting / abuse control regression
// coverage). Mirrors src/server/assignments/rate-limit.test.ts's own coverage style for the
// identical sliding-window algorithm, plus the scope-namespacing and retry-header behavior this
// shared, multi-consumer version adds on top.

describe("checkRateLimit", () => {
  it("allows attempts up to the max, then blocks with a safe retry-after hint", () => {
    const dimension = `actor-${Math.random()}`;
    for (let i = 0; i < 5; i += 1) {
      expect(checkRateLimit("test-scope", dimension, 5, 60_000)).toEqual({ allowed: true });
    }
    const blocked = checkRateLimit("test-scope", dimension, 5, 60_000);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBe(60);
  });

  it("namespaces by scope - the SAME dimension key in two different scopes is tracked independently", () => {
    const dimension = `actor-${Math.random()}`;
    for (let i = 0; i < 3; i += 1) expect(checkRateLimit("scope-a", dimension, 3, 60_000)).toEqual({ allowed: true });
    expect(checkRateLimit("scope-a", dimension, 3, 60_000).allowed).toBe(false);
    // Same dimension key, different scope: a fresh bucket, never shares state with scope-a.
    expect(checkRateLimit("scope-b", dimension, 3, 60_000)).toEqual({ allowed: true });
  });

  it("tracks distinct dimension keys within the same scope independently", () => {
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    for (let i = 0; i < 3; i += 1) expect(checkRateLimit("scope-c", a, 3, 60_000).allowed).toBe(true);
    expect(checkRateLimit("scope-c", a, 3, 60_000).allowed).toBe(false);
    expect(checkRateLimit("scope-c", b, 3, 60_000).allowed).toBe(true);
  });

  it("accepts a custom RateLimiter (the pluggable seam for a real production provider)", () => {
    let calls = 0;
    const stub: RateLimiter = {
      checkAndRecord: () => {
        calls += 1;
        return calls <= 2;
      },
    };
    expect(checkRateLimit("stub-scope", "dim", 999, 999, stub)).toEqual({ allowed: true });
    expect(checkRateLimit("stub-scope", "dim", 999, 999, stub)).toEqual({ allowed: true });
    const third = checkRateLimit("stub-scope", "dim", 999, 999, stub);
    expect(third.allowed).toBe(false);
  });

  it("getDefaultRateLimiter returns the same shared, process-wide instance every call", () => {
    expect(getDefaultRateLimiter()).toBe(getDefaultRateLimiter());
  });
});

describe("requestIpKey", () => {
  it("reads the first address from x-forwarded-for", () => {
    const request = new Request("https://example.com", { headers: { "x-forwarded-for": "9.9.9.9, 1.1.1.1" } });
    expect(requestIpKey(request)).toBe("9.9.9.9");
  });

  it("falls back to a safe placeholder when no header is present", () => {
    expect(requestIpKey(new Request("https://example.com"))).toBe("unknown");
  });
});
