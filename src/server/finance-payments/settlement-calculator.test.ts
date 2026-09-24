import { describe, expect, it } from "vitest";

import { computeSettlement } from "./settlement-calculator";

describe("computeSettlement", () => {
  it("returns UNPAID with zero totals when there are no payments", () => {
    const result = computeSettlement(90_000, []);
    expect(result).toEqual({ expectedNetPaymentMinor: 90_000, confirmedPaidMinor: 0, recordedPendingMinor: 0, failedMinor: 0, remainingMinor: 90_000, overpaidByMinor: 0, state: "UNPAID", warnings: [] });
  });

  it("section 9's own worked example: expected 90,000, confirmed 50,000, recorded 20,000 -> PARTIALLY_PAID, remaining 40,000", () => {
    const result = computeSettlement(90_000, [
      { status: "CONFIRMED", amountMinor: 50_000 },
      { status: "RECORDED", amountMinor: 20_000 },
    ]);
    expect(result.confirmedPaidMinor).toBe(50_000);
    expect(result.recordedPendingMinor).toBe(20_000);
    expect(result.remainingMinor).toBe(40_000);
    expect(result.state).toBe("PARTIALLY_PAID");
    expect(result.overpaidByMinor).toBe(0);
  });

  it("is PAID exactly when confirmed equals expected", () => {
    const result = computeSettlement(90_000, [{ status: "CONFIRMED", amountMinor: 90_000 }]);
    expect(result.state).toBe("PAID");
    expect(result.remainingMinor).toBe(0);
  });

  it("is OVERPAID when confirmed exceeds expected, and reports the excess separately", () => {
    const result = computeSettlement(90_000, [
      { status: "CONFIRMED", amountMinor: 60_000 },
      { status: "CONFIRMED", amountMinor: 50_000 },
    ]);
    expect(result.state).toBe("OVERPAID");
    expect(result.confirmedPaidMinor).toBe(110_000);
    expect(result.remainingMinor).toBe(0); // never negative
    expect(result.overpaidByMinor).toBe(20_000);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("only CONFIRMED reduces remaining - RECORDED (pending) and FAILED never count", () => {
    const result = computeSettlement(100_000, [
      { status: "RECORDED", amountMinor: 40_000 },
      { status: "FAILED", amountMinor: 30_000 },
    ]);
    expect(result.confirmedPaidMinor).toBe(0);
    expect(result.remainingMinor).toBe(100_000);
    expect(result.recordedPendingMinor).toBe(40_000);
    expect(result.failedMinor).toBe(30_000);
    expect(result.state).toBe("UNPAID");
  });

  it("DRAFT and VOID payments are simply never passed in by the caller - they never appear as a status here at all in practice, but a stray one still contributes nothing (defensive)", () => {
    const result = computeSettlement(100_000, [
      { status: "DRAFT", amountMinor: 999_999 },
      { status: "VOID", amountMinor: 999_999 },
    ]);
    expect(result.confirmedPaidMinor).toBe(0);
    expect(result.recordedPendingMinor).toBe(0);
    expect(result.failedMinor).toBe(0);
    expect(result.remainingMinor).toBe(100_000);
  });

  it("REVIEW_REQUIRED with a null expected net payment - remaining is null too, never a misleading number", () => {
    const result = computeSettlement(null, [{ status: "CONFIRMED", amountMinor: 10_000 }]);
    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(result.remainingMinor).toBeNull();
    expect(result.confirmedPaidMinor).toBe(10_000); // still reported even though the state is ambiguous
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("warns when recorded pending would overpay if confirmed as-is, while still reporting a non-overpaid state", () => {
    const result = computeSettlement(100_000, [
      { status: "CONFIRMED", amountMinor: 80_000 },
      { status: "RECORDED", amountMinor: 30_000 },
    ]);
    expect(result.state).toBe("PARTIALLY_PAID");
    expect(result.warnings.some((w) => /exceed/i.test(w))).toBe(true);
  });

  it("is deterministic - the same inputs always produce the same output (pure function, no side effects)", () => {
    const inputs = [{ status: "CONFIRMED" as const, amountMinor: 12_345 }];
    const a = computeSettlement(50_000, inputs);
    const b = computeSettlement(50_000, inputs);
    expect(a).toEqual(b);
  });
});
