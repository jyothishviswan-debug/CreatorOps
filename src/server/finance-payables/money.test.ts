import { describe, expect, it } from "vitest";

import { percentBpsOfMinor, prorateMinor } from "./money";

describe("prorateMinor", () => {
  it("computes the documented example exactly: 10,000,000 * 16 / 20 = 8,000,000", () => {
    expect(prorateMinor(10_000_000, 16, 20)).toBe(8_000_000);
  });

  it("actual === required returns the full fixed amount", () => {
    expect(prorateMinor(5_000_000, 20, 20)).toBe(5_000_000);
  });

  it("actual = 0 returns 0", () => {
    expect(prorateMinor(5_000_000, 0, 20)).toBe(0);
  });

  it("rounds a fractional minor unit half-up", () => {
    // 100 * 1 / 3 = 33.333... -> 33
    expect(prorateMinor(100, 1, 3)).toBe(33);
    // 100 * 2 / 3 = 66.666... -> 67
    expect(prorateMinor(100, 2, 3)).toBe(67);
    // 5 * 1 / 2 = 2.5 -> half-up rounds to 3
    expect(prorateMinor(5, 1, 2)).toBe(3);
  });

  it("stays exact at large minor-unit values (no float drift)", () => {
    // Would lose precision under naive `a * b / c` float division for some inputs; BigInt keeps it exact.
    expect(prorateMinor(999_999_999, 999_999, 1_000_000)).toBe(999_998_999);
  });

  it("rejects a cappedActualCount greater than requiredCount (the caller must cap first)", () => {
    expect(() => prorateMinor(1000, 25, 20)).toThrow();
  });

  it("rejects a non-positive requiredCount", () => {
    expect(() => prorateMinor(1000, 0, 0)).toThrow();
  });
});

describe("percentBpsOfMinor", () => {
  it("computes 10% TDS on a service base exactly", () => {
    expect(percentBpsOfMinor(8_000_000, 1000)).toBe(800_000);
  });

  it("computes an 18% GST example", () => {
    expect(percentBpsOfMinor(8_000_000, 1800)).toBe(1_440_000);
  });

  it("rounds half-up on a fractional minor unit", () => {
    // 100 * 1000 / 10000 = 10 exactly
    expect(percentBpsOfMinor(100, 1000)).toBe(10);
    // 15 * 1000 / 10000 = 1.5 -> half-up rounds to 2
    expect(percentBpsOfMinor(15, 1000)).toBe(2);
  });

  it("zero rate yields zero", () => {
    expect(percentBpsOfMinor(8_000_000, 0)).toBe(0);
  });

  it("rejects a rate outside [0, 10000] bps", () => {
    expect(() => percentBpsOfMinor(100, 10_001)).toThrow();
    expect(() => percentBpsOfMinor(100, -1)).toThrow();
  });
});
