import { describe, expect, it } from "vitest";

import { bandFor, buildDistribution, VIEW_BAND_SET_V1 } from "./bands";

describe("performance bands", () => {
  it("places a value at the low boundary of its band (half-open [min,max))", () => {
    expect(bandFor(VIEW_BAND_SET_V1, 0)?.label).toBe("0-1K");
    expect(bandFor(VIEW_BAND_SET_V1, 999)?.label).toBe("0-1K");
    expect(bandFor(VIEW_BAND_SET_V1, 1_000)?.label).toBe("1K-5K");
  });

  it("the final band is open-ended (100M+)", () => {
    expect(bandFor(VIEW_BAND_SET_V1, 100_000_000)?.label).toBe("100M+");
    expect(bandFor(VIEW_BAND_SET_V1, 999_999_999)?.label).toBe("100M+");
  });

  it("a negative value has no band", () => {
    expect(bandFor(VIEW_BAND_SET_V1, -5)).toBeNull();
  });

  it("buildDistribution counts null values separately, never as the lowest band (missing != zero)", () => {
    const result = buildDistribution([null, 0, 500, 2_000, null]);
    expect(result.omittedNullCount).toBe(2);
    expect(result.totalCounted).toBe(3);
    const zeroToOneK = result.bands.find((b) => b.label === "0-1K");
    expect(zeroToOneK?.count).toBe(2);
    const oneKToFiveK = result.bands.find((b) => b.label === "1K-5K");
    expect(oneKToFiveK?.count).toBe(1);
  });

  it("carries the band set id/version for traceability", () => {
    const result = buildDistribution([100]);
    expect(result.bandSetId).toBe(VIEW_BAND_SET_V1.bandSetId);
    expect(result.bandSetVersion).toBe(VIEW_BAND_SET_V1.version);
  });

  it("throws on an unknown band set id (never silently falls back)", () => {
    expect(() => buildDistribution([1], "not-a-real-band-set")).toThrow();
  });
});
