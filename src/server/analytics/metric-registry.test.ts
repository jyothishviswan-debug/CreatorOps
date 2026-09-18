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
});

describe("platform normalization reuse", () => {
  it("re-exports the exact shared normalizer Partner Account already uses - no local re-derivation", () => {
    expect(normalizePlatformIdentifier(" Instagram ")).toBe("instagram");
    expect(normalizePlatformIdentifier("YouTube")).toBe("youtube");
  });
});
