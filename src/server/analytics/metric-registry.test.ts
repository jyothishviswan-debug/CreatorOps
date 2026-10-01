import { describe, expect, it } from "vitest";

import { normalizePlatformIdentifier } from "@/server/shared/platform";
import { ANALYTICS_METRIC_IDS, ANALYTICS_METRIC_REGISTRY, UNSUPPORTED_METRIC_IDS, isAnalyticsMetricId, isUnsupportedMetricId, parseSupportedDateTime, parseSupportedMetric } from "./metric-registry";

describe("ANALYTICS_METRIC_REGISTRY", () => {
  it("has exactly one registry entry per canonical metric id", () => {
    expect(Object.keys(ANALYTICS_METRIC_REGISTRY).sort()).toEqual([...ANALYTICS_METRIC_IDS].sort());
  });

  it("isAnalyticsMetricId only accepts registry ids", () => {
    expect(isAnalyticsMetricId("comments")).toBe(true);
    expect(isAnalyticsMetricId("reach")).toBe(false);
    expect(isAnalyticsMetricId("not-a-real-thing")).toBe(false);
  });
});

describe("UNSUPPORTED_METRIC_IDS", () => {
  it("is the exact closed rejection list, disjoint from the supported registry", () => {
    expect([...UNSUPPORTED_METRIC_IDS].sort()).toEqual(["authenticityScore", "blendedPerformanceScore", "demographics", "impressions", "reach", "saves", "shares", "watchTimeMinutes"].sort());
    for (const id of UNSUPPORTED_METRIC_IDS) {
      expect(isAnalyticsMetricId(id)).toBe(false);
    }
  });

  it("isUnsupportedMetricId only accepts the rejection list", () => {
    expect(isUnsupportedMetricId("reach")).toBe(true);
    expect(isUnsupportedMetricId("comments")).toBe(false);
  });
});

describe("parseSupportedMetric - missing must never become zero", () => {
  it("returns null for null/undefined/blank/unparseable input", () => {
    expect(parseSupportedMetric(null)).toBeNull();
    expect(parseSupportedMetric(undefined)).toBeNull();
    expect(parseSupportedMetric("")).toBeNull();
    expect(parseSupportedMetric("   ")).toBeNull();
    expect(parseSupportedMetric("not-a-number")).toBeNull();
    expect(parseSupportedMetric("$45")).toBeNull();
  });

  it("never coerces a missing value to 0 - null and 0 remain distinguishable", () => {
    expect(parseSupportedMetric(null)).not.toBe(0);
    expect(parseSupportedMetric("0")).toBe(0);
  });

  it("parses plain numbers and numeric strings, tolerating thousands separators and a trailing percent", () => {
    expect(parseSupportedMetric(42)).toBe(42);
    expect(parseSupportedMetric("42")).toBe(42);
    expect(parseSupportedMetric("1,234")).toBe(1234);
    expect(parseSupportedMetric("12.5%")).toBe(12.5);
    expect(parseSupportedMetric(-3)).toBe(-3);
  });

  it("rejects a non-finite number", () => {
    expect(parseSupportedMetric(Number.NaN)).toBeNull();
    expect(parseSupportedMetric(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("parseSupportedDateTime", () => {
  it("returns null for missing/unparseable input, never throws", () => {
    expect(parseSupportedDateTime(null)).toBeNull();
    expect(parseSupportedDateTime(undefined)).toBeNull();
    expect(parseSupportedDateTime("")).toBeNull();
    expect(parseSupportedDateTime("not a date at all !!")).toBeNull();
  });

  it("parses an ISO-ish string into a real ISO timestamp", () => {
    const result = parseSupportedDateTime("2025-01-15T10:00:00Z");
    expect(result).toBe(new Date("2025-01-15T10:00:00Z").toISOString());
  });

  it("parses an Excel serial date within a sane range", () => {
    const result = parseSupportedDateTime(45000);
    expect(result).not.toBeNull();
    expect(new Date(result!).getFullYear()).toBeGreaterThan(2020);
  });

  it("rejects an out-of-range Excel serial number", () => {
    expect(parseSupportedDateTime(-5)).toBeNull();
    expect(parseSupportedDateTime(999999)).toBeNull();
  });

  it("accepts a real Date object, and null for an Invalid Date", () => {
    expect(parseSupportedDateTime(new Date("2026-09-23T00:00:00Z"))).toBe("2026-09-23T00:00:00.000Z");
    expect(parseSupportedDateTime(new Date("not a date"))).toBeNull();
  });

  // Remediation-plan Wave B / finding #65 re-audit.
  it("a date-only ISO string is UTC midnight, regardless of the server's local timezone", () => {
    expect(parseSupportedDateTime("2026-09-23")).toBe("2026-09-23T00:00:00.000Z");
  });

  it("an ISO datetime with an explicit offset/Z is parsed exactly, unaffected by server timezone", () => {
    expect(parseSupportedDateTime("2026-09-23T18:57:26+05:30")).toBe(new Date("2026-09-23T18:57:26+05:30").toISOString());
    expect(parseSupportedDateTime("2026-09-23T13:27:26Z")).toBe("2026-09-23T13:27:26.000Z");
  });

  it("an ISO datetime with NO explicit zone is treated as UTC (never the server's local zone) - a documented, deterministic choice", () => {
    expect(parseSupportedDateTime("2026-09-23T18:57:26")).toBe("2026-09-23T18:57:26.000Z");
    // a space instead of 'T' is also accepted (a common export convention), same UTC treatment
    expect(parseSupportedDateTime("2026-09-23 18:57:26")).toBe("2026-09-23T18:57:26.000Z");
  });

  it("REJECTS a non-ISO date string rather than guessing it via the locale-ambiguous general Date grammar - the real bug this re-audit found", () => {
    // "09/23/2026" (a plausible MM/DD/YYYY export value) is exactly the format that silently shifted
    // by a calendar day depending on server timezone before this fix - now explicitly rejected.
    expect(parseSupportedDateTime("09/23/2026")).toBeNull();
    expect(parseSupportedDateTime("23/09/2026")).toBeNull();
    expect(parseSupportedDateTime("Sep 23, 2026")).toBeNull();
    expect(parseSupportedDateTime("23 September 2026")).toBeNull();
  });
});

describe("platform normalization reuse", () => {
  it("re-exports the exact shared normalizer Partner Account already uses - no local re-derivation", () => {
    expect(normalizePlatformIdentifier(" Instagram ")).toBe("instagram");
    expect(normalizePlatformIdentifier("YouTube")).toBe("youtube");
  });
});
