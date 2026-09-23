import { describe, expect, it } from "vitest";

import {
  commercialPeriodLabel,
  formatFileSize,
  formatMoneyMinor,
  formatSignedMoneyMinor,
  invoiceStatusChip,
  minorToInputText,
  parseMoneyInputToMinor,
  parseRatePercentToBasisPoints,
  ratePercentText,
  reconciliationChip,
} from "./format";

describe("formatMoneyMinor", () => {
  it("shows Hidden when amounts are not visible, regardless of value", () => {
    expect(formatMoneyMinor(500000, "INR", { amountsVisible: false })).toBe("Hidden");
    expect(formatMoneyMinor(null, "INR", { amountsVisible: false })).toBe("Hidden");
  });

  it("shows — for null when amounts are visible", () => {
    expect(formatMoneyMinor(null, "INR", { amountsVisible: true })).toBe("—");
  });

  it("formats an unsigned amount with en-IN grouping and a rupee symbol", () => {
    expect(formatMoneyMinor(150000, "INR", { amountsVisible: true })).toBe("₹1,500");
    expect(formatMoneyMinor(1050000, "INR", { amountsVisible: true })).toBe("₹10,500");
    expect(formatMoneyMinor(50, "INR", { amountsVisible: true })).toBe("₹0.50");
  });

  it("falls back to a currency-code prefix for an unknown currency", () => {
    expect(formatMoneyMinor(150000, "USD", { amountsVisible: true })).toBe("USD 1,500");
  });
});

describe("formatSignedMoneyMinor", () => {
  it("renders a negative signed amount with a leading minus", () => {
    expect(formatSignedMoneyMinor(-150000, "INR", { amountsVisible: true })).toBe("-₹1,500");
  });
});

describe("minorToInputText / parseMoneyInputToMinor round-trip", () => {
  it("round-trips a whole and a fractional amount", () => {
    expect(minorToInputText(150000)).toBe("1500");
    expect(minorToInputText(150050)).toBe("1500.50");
    expect(parseMoneyInputToMinor("1500")).toEqual({ ok: true, amountMinor: 150000 });
    expect(parseMoneyInputToMinor("1,500.50")).toEqual({ ok: true, amountMinor: 150050 });
  });

  it("rejects garbage input", () => {
    expect(parseMoneyInputToMinor("")).toEqual({ ok: false, message: "Enter an amount." });
    expect(parseMoneyInputToMinor("abc").ok).toBe(false);
    expect(parseMoneyInputToMinor("1.999").ok).toBe(false);
  });
});

describe("ratePercentText / parseRatePercentToBasisPoints", () => {
  it("formats basis points as a percent", () => {
    expect(ratePercentText(1800)).toBe("18%");
    expect(ratePercentText(1850)).toBe("18.50%");
    expect(ratePercentText(null)).toBe("—");
  });

  it("parses a percent string to basis points, and blank to null (amount-only line)", () => {
    expect(parseRatePercentToBasisPoints("18")).toEqual({ ok: true, value: 1800 });
    expect(parseRatePercentToBasisPoints("18.5")).toEqual({ ok: true, value: 1850 });
    expect(parseRatePercentToBasisPoints("")).toEqual({ ok: true, value: null });
    expect(parseRatePercentToBasisPoints("abc").ok).toBe(false);
  });
});

describe("commercialPeriodLabel", () => {
  it("expands YYYY-MM to a month name", () => {
    expect(commercialPeriodLabel("2026-03")).toBe("March 2026");
  });
  it("returns an unrecognized shape verbatim", () => {
    expect(commercialPeriodLabel("garbage")).toBe("garbage");
  });
});

describe("formatFileSize", () => {
  it("scales bytes/KB/MB", () => {
    expect(formatFileSize(500)).toBe("500 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("invoiceStatusChip / reconciliationChip", () => {
  it("maps every lifecycle status to a human label", () => {
    expect(invoiceStatusChip("DRAFT").label).toBe("Draft");
    expect(invoiceStatusChip("SUBMITTED").label).toBe("Submitted");
    expect(invoiceStatusChip("APPROVED").label).toBe("Approved");
    expect(invoiceStatusChip("REJECTED").label).toBe("Rejected");
    expect(invoiceStatusChip("VOID").label).toBe("Void");
  });

  it("maps every reconciliation state to a human label, never a raw enum", () => {
    expect(reconciliationChip("MATCH").label).toBe("Match");
    expect(reconciliationChip("MISMATCH").label).toBe("Mismatch");
    expect(reconciliationChip("REVIEW_REQUIRED").label).toBe("Review required");
    expect(reconciliationChip("BLOCKED").label).toBe("Blocked");
    expect(reconciliationChip("MISSING_IN_INVOICE").label).toBe("Missing information");
    expect(reconciliationChip("MISSING_IN_PAYABLE").label).toBe("Missing information");
  });
});
