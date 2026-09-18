import { describe, expect, it } from "vitest";

import { checkAndRecordAttempt, rateLimitTokenKey, requestIpKey } from "./rate-limit";

// Step 10A.1 section 5: focused, pure-function coverage for the minimal
// local rate limiter guarding the public external-submission routes.
// Explicitly NOT a production rate limiter - in-process, per-server-
// instance, no shared state (see rate-limit.ts's own header comment).

describe("checkAndRecordAttempt", () => {
  it("allows attempts up to the max, then blocks the next one within the same window", () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 5; i += 1) {
      expect(checkAndRecordAttempt(key, 5, 60_000)).toBe(true);
    }
    expect(checkAndRecordAttempt(key, 5, 60_000)).toBe(false);
  });

  it("tracks distinct keys independently - exhausting one key never blocks another", () => {
    const keyA = `a-${Math.random()}`;
    const keyB = `b-${Math.random()}`;
    for (let i = 0; i < 3; i += 1) expect(checkAndRecordAttempt(keyA, 3, 60_000)).toBe(true);
    expect(checkAndRecordAttempt(keyA, 3, 60_000)).toBe(false);
    expect(checkAndRecordAttempt(keyB, 3, 60_000)).toBe(true);
  });

  it("a zero-width window means every call is treated as outside the previous window (allows again immediately)", () => {
    const key = `zero-${Math.random()}`;
    expect(checkAndRecordAttempt(key, 1, 0)).toBe(true);
    // With windowMs=0, `now - t < 0` is never true for a just-recorded
    // timestamp, so the prior attempt is already outside the window.
    expect(checkAndRecordAttempt(key, 1, 0)).toBe(true);
  });
});

describe("rateLimitTokenKey", () => {
  it("never returns the raw token itself", () => {
    const token = "super-secret-raw-bearer-token-value";
    const key = rateLimitTokenKey(token);
    expect(key).not.toBe(token);
    expect(key).not.toContain(token);
  });

  it("is deterministic for the same token", () => {
    const token = "same-token-twice";
    expect(rateLimitTokenKey(token)).toBe(rateLimitTokenKey(token));
  });

  it("differs for different tokens", () => {
    expect(rateLimitTokenKey("token-a")).not.toBe(rateLimitTokenKey("token-b"));
  });
});

describe("requestIpKey", () => {
  it("reads the first address from x-forwarded-for", () => {
    const request = new Request("https://example.com", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
    expect(requestIpKey(request)).toBe("1.2.3.4");
  });

  it("falls back to a safe placeholder when no header is present", () => {
    const request = new Request("https://example.com");
    expect(requestIpKey(request)).toBe("unknown");
  });
});
