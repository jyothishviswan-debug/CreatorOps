import { describe, expect, it } from "vitest";

import { commercialPeriodLabel, formatMoneyMinor, minorToInputText, parseMoneyInputToMinor, paymentMethodLabel, paymentStatusChip, settlementStateChip } from "./format";

describe("formatMoneyMinor", () => {
  it("formats INR minor units with en-IN grouping", () => {
    expect(formatMoneyMinor(500000, "INR", { amountsVisible: true })).toBe("₹5,000");
    expect(formatMoneyMinor(1234567, "INR", { amountsVisible: true })).toBe("₹12,345.67");
  });

  it("shows Hidden when amounts are not visible, even for a non-null value", () => {
    expect(formatMoneyMinor(500000, "INR", { amountsVisible: false })).toBe("Hidden");
  });

  it("distinguishes a withheld amount from a null (not-yet-declared) one only via amountsVisible", () => {
    expect(formatMoneyMinor(null, "INR", { amountsVisible: true })).toBe("—");
    expect(formatMoneyMinor(null, "INR", { amountsVisible: false })).toBe("Hidden");
  });
});

describe("parseMoneyInputToMinor", () => {
  it("parses plain and comma-grouped amounts", () => {
    expect(parseMoneyInputToMinor("35000")).toEqual({ ok: true, amountMinor: 3500000 });
    expect(parseMoneyInputToMinor("35,000.50")).toEqual({ ok: true, amountMinor: 3500050 });
    expect(parseMoneyInputToMinor("₹ 3,50,000")).toEqual({ ok: true, amountMinor: 35000000 });
  });

  it("rejects a zero or blank amount - a Payment amount is never zero", () => {
    expect(parseMoneyInputToMinor("")).toEqual({ ok: false, message: "Enter an amount." });
    expect(parseMoneyInputToMinor("0")).toEqual({ ok: false, message: "Enter an amount greater than zero." });
  });

  it("rejects more than two decimal places", () => {
    expect(parseMoneyInputToMinor("35000.123").ok).toBe(false);
  });

  it("round-trips through minorToInputText", () => {
    expect(minorToInputText(3500000)).toBe("35000");
    expect(minorToInputText(3500050)).toBe("35000.50");
  });
});

describe("commercialPeriodLabel", () => {
  it("formats a YYYY-MM period key", () => {
    expect(commercialPeriodLabel("2026-03")).toBe("March 2026");
  });

  it("returns an unrecognized shape verbatim", () => {
    expect(commercialPeriodLabel("not-a-period")).toBe("not-a-period");
  });
});

describe("paymentStatusChip", () => {
  it("maps every lifecycle status to a label/tone", () => {
    expect(paymentStatusChip("DRAFT")).toEqual({ label: "Draft", tone: "gray" });
    expect(paymentStatusChip("RECORDED")).toEqual({ label: "Recorded", tone: "orange" });
    expect(paymentStatusChip("CONFIRMED")).toEqual({ label: "Confirmed", tone: "default" });
    expect(paymentStatusChip("FAILED")).toEqual({ label: "Failed", tone: "red" });
    expect(paymentStatusChip("VOID")).toEqual({ label: "Void", tone: "red" });
  });
});

describe("settlementStateChip", () => {
  it("never renders a partially paid Invoice as Paid", () => {
    expect(settlementStateChip("PARTIALLY_PAID").label).toBe("Partially paid");
    expect(settlementStateChip("PAID").label).toBe("Paid");
    expect(settlementStateChip("UNPAID").label).toBe("Unpaid");
    expect(settlementStateChip("REVIEW_REQUIRED").label).toBe("Review required");
    expect(settlementStateChip("OVERPAID").label).toBe("Review required");
  });
});

describe("paymentMethodLabel", () => {
  it("maps every method to a human label", () => {
    expect(paymentMethodLabel("BANK_TRANSFER")).toBe("Bank transfer");
    expect(paymentMethodLabel("UPI")).toBe("UPI");
    expect(paymentMethodLabel(null)).toBe("—");
  });
});
