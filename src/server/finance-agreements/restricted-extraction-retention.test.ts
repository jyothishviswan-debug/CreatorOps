import { describe, expect, it } from "vitest";

import { isRestrictedExtractionPurgeEligible } from "./restricted-extraction-retention";

// Production hardening (base spec section 6): the pure retention-eligibility rule, tested
// independently of Firestore/auth so its logic is unambiguous before restricted-extraction-
// retention.emulator.test.ts exercises the full authorized purge action end to end.
describe("isRestrictedExtractionPurgeEligible", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");

  it("is never eligible when no retention window is configured, no matter how old the record is", () => {
    expect(isRestrictedExtractionPurgeEligible("2000-01-01T00:00:00.000Z", null, now)).toBe(false);
  });

  it("is not eligible before the configured window has elapsed", () => {
    const createdAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days old
    expect(isRestrictedExtractionPurgeEligible(createdAt, 30, now)).toBe(false);
  });

  it("is eligible exactly at and beyond the configured window", () => {
    const exactlyAtWindow = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(isRestrictedExtractionPurgeEligible(exactlyAtWindow, 30, now)).toBe(true);

    const wellBeyondWindow = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString();
    expect(isRestrictedExtractionPurgeEligible(wellBeyondWindow, 30, now)).toBe(true);
  });

  it("fails safe (not eligible) on an unparseable createdAt rather than throwing", () => {
    expect(isRestrictedExtractionPurgeEligible("not-a-date", 30, now)).toBe(false);
  });

  it("never reads Date.now()/the environment itself - identical input always produces identical output (pure)", () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const first = isRestrictedExtractionPurgeEligible(createdAt, 30, now);
    const second = isRestrictedExtractionPurgeEligible(createdAt, 30, now);
    expect(first).toBe(second);
  });
});
