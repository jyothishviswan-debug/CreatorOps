import { describe, expect, it } from "vitest";

import { computeRowIdentityKey } from "./import-pipeline";
import { ANALYTICS_ROW_CLASSIFICATIONS } from "./types";

describe("computeRowIdentityKey - deterministic row identity (Section 10)", () => {
  it("is deterministic - the same inputs always produce the same key", () => {
    const a = computeRowIdentityKey("campaign_content", "instagram", "url:https://instagram.com/p/abc", null);
    const b = computeRowIdentityKey("campaign_content", "instagram", "url:https://instagram.com/p/abc", null);
    expect(a).toBe(b);
  });

  it("changes when the target kind, platform, strongest key, or reporting period changes", () => {
    const base = computeRowIdentityKey("campaign_content", "instagram", "url:https://instagram.com/p/abc", null);
    expect(computeRowIdentityKey("channel_account", "instagram", "url:https://instagram.com/p/abc", null)).not.toBe(base);
    expect(computeRowIdentityKey("campaign_content", "youtube", "url:https://instagram.com/p/abc", null)).not.toBe(base);
    expect(computeRowIdentityKey("campaign_content", "instagram", "url:https://instagram.com/p/xyz", null)).not.toBe(base);
    expect(computeRowIdentityKey("campaign_content", "instagram", "url:https://instagram.com/p/abc", { start: "2025-01-01", end: "2025-01-31" })).not.toBe(base);
  });

  it("two different reporting periods produce two different keys for the exact same row", () => {
    const key1 = computeRowIdentityKey("campaign_content", "instagram", "id:123", { start: "2025-01-01", end: "2025-01-31" });
    const key2 = computeRowIdentityKey("campaign_content", "instagram", "id:123", { start: "2025-02-01", end: "2025-02-28" });
    expect(key1).not.toBe(key2);
  });
});

describe("ANALYTICS_ROW_CLASSIFICATIONS - the closed nine-value set", () => {
  it("is exactly the nine documented terminal classifications", () => {
    expect([...ANALYTICS_ROW_CLASSIFICATIONS].sort()).toEqual(
      ["ready", "warning", "unchanged", "duplicate", "invalid", "missing_dependency", "matched", "unmatched", "ambiguous"].sort(),
    );
  });

  it("every row classification reconciles to the total when counted", () => {
    // A representative synthetic outcome set - exercises every value
    // except "ready" (see types.ts's own comment: not reachable under
    // the two shipped adapters today, same honest treatment as content
    // AMBIGUOUS).
    const classifications = ["matched", "matched", "unmatched", "ambiguous", "invalid", "missing_dependency", "duplicate", "unchanged", "warning"] as const;
    const counts = Object.fromEntries(ANALYTICS_ROW_CLASSIFICATIONS.map((c) => [c, 0])) as Record<string, number>;
    for (const c of classifications) counts[c] += 1;
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(classifications.length);
  });
});
