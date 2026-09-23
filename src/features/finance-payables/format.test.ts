import { describe, expect, it } from "vitest";

import { PAYABLE_COUNTERPARTY_TYPES, PAYABLE_DETERMINATION_STATES, PAYABLE_LINE_CATEGORIES, PAYABLE_REVIEW_CODES, PAYABLE_STATUSES } from "@/server/finance-payables/types";

import {
  commercialPeriodLabel,
  counterpartyTypeLabel,
  determinationChip,
  formatSignedMoneyMinor,
  lineCategoryLabel,
  minorToInputText,
  parseSignedMoneyInputToMinor,
  payableStatusChip,
  reviewCodeComponentLabel,
  sourceRefLabel,
} from "./format";

describe("payableStatusChip / determinationChip / counterpartyTypeLabel / lineCategoryLabel", () => {
  it("has a chip for every PayableStatus with human, non-camelCase text", () => {
    for (const status of PAYABLE_STATUSES) {
      const chip = payableStatusChip(status);
      expect(chip.label).not.toBe(status);
      expect(chip.label.length).toBeGreaterThan(0);
    }
  });

  it("never calls READY_FOR_INVOICE an approval", () => {
    expect(payableStatusChip("READY_FOR_INVOICE").label.toLowerCase()).not.toContain("approv");
  });

  it("has a chip for every PayableDeterminationState", () => {
    for (const state of PAYABLE_DETERMINATION_STATES) expect(determinationChip(state).label).not.toBe(state);
  });

  it("has a label for every PayableCounterpartyType", () => {
    for (const type of PAYABLE_COUNTERPARTY_TYPES) expect(counterpartyTypeLabel(type)).not.toBe(type);
  });

  it("has a label for every PayableLineCategory", () => {
    for (const category of PAYABLE_LINE_CATEGORIES) expect(lineCategoryLabel(category)).not.toBe(category);
  });

  it("has a component label for every PayableReviewCode, and never exposes the raw enum value", () => {
    for (const code of PAYABLE_REVIEW_CODES) {
      const label = reviewCodeComponentLabel(code);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(code);
      expect(label).not.toContain("_");
    }
  });
});

describe("commercialPeriodLabel", () => {
  it("formats a YYYY-MM period as 'Month YYYY'", () => {
    expect(commercialPeriodLabel("2024-03")).toBe("March 2024");
    expect(commercialPeriodLabel("2026-12")).toBe("December 2026");
    expect(commercialPeriodLabel("2026-01")).toBe("January 2026");
  });

  it("returns an unrecognized shape verbatim rather than guessing", () => {
    expect(commercialPeriodLabel("not-a-period")).toBe("not-a-period");
  });
});

describe("formatSignedMoneyMinor", () => {
  it("shows 'Hidden' when amounts are not visible, regardless of the value", () => {
    expect(formatSignedMoneyMinor(500000, "INR", { amountsVisible: false })).toBe("Hidden");
    expect(formatSignedMoneyMinor(null, "INR", { amountsVisible: false })).toBe("Hidden");
    expect(formatSignedMoneyMinor(-500000, "INR", { amountsVisible: false })).toBe("Hidden");
  });

  it("formats a positive amount with the currency symbol and Indian grouping", () => {
    expect(formatSignedMoneyMinor(500000, "INR", { amountsVisible: true })).toBe("₹5,000");
    expect(formatSignedMoneyMinor(123456789, "INR", { amountsVisible: true })).toBe("₹12,34,567.89");
  });

  it("formats a negative amount with a leading minus, symbol after the sign", () => {
    expect(formatSignedMoneyMinor(-500000, "INR", { amountsVisible: true })).toBe("-₹5,000");
  });

  it("falls back to a code prefix for an unknown currency", () => {
    expect(formatSignedMoneyMinor(100000, "USD", { amountsVisible: true })).toBe("USD 1,000");
  });

  it("shows the neutral dash for null when amounts ARE visible (a genuinely absent figure, not withheld)", () => {
    expect(formatSignedMoneyMinor(null, "INR", { amountsVisible: true })).toBe("—");
  });

  it("shows decimals only when non-zero, unless alwaysDecimals is set", () => {
    expect(formatSignedMoneyMinor(500000, "INR", { amountsVisible: true })).toBe("₹5,000");
    expect(formatSignedMoneyMinor(500000, "INR", { amountsVisible: true, alwaysDecimals: true })).toBe("₹5,000.00");
  });
});

describe("parseSignedMoneyInputToMinor / minorToInputText round-trip", () => {
  it("parses a plain positive amount", () => {
    const result = parseSignedMoneyInputToMinor("35000");
    expect(result).toEqual({ ok: true, amountMinorSigned: 3500000 });
  });

  it("parses a negative amount (both '-' and the unicode minus sign)", () => {
    expect(parseSignedMoneyInputToMinor("-35000")).toEqual({ ok: true, amountMinorSigned: -3500000 });
    expect(parseSignedMoneyInputToMinor("−35000")).toEqual({ ok: true, amountMinorSigned: -3500000 });
  });

  it("parses grouped and rupee-prefixed input", () => {
    expect(parseSignedMoneyInputToMinor("₹ 35,000.50")).toEqual({ ok: true, amountMinorSigned: 3500050 });
  });

  it("rejects empty input and more than 2 decimal places", () => {
    expect(parseSignedMoneyInputToMinor("").ok).toBe(false);
    expect(parseSignedMoneyInputToMinor("35.999").ok).toBe(false);
  });

  it("round-trips through minorToInputText", () => {
    const parsed = parseSignedMoneyInputToMinor("-1,234.50");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(minorToInputText(parsed.amountMinorSigned)).toBe("-1234.50");
  });

  it("minorToInputText returns empty text for null", () => {
    expect(minorToInputText(null)).toBe("");
  });
});

describe("sourceRefLabel", () => {
  it("names only the Agreement for an agreement-only source", () => {
    expect(sourceRefLabel({ agreementRef: "agr_abc", agreementVersion: 2, reviewRef: null, reviewVersion: null })).toBe("Agreement agr_abc · v2");
  });

  it("names both the Agreement and the Partner Review when both are pinned", () => {
    expect(sourceRefLabel({ agreementRef: "agr_abc", agreementVersion: 2, reviewRef: "pr_xyz", reviewVersion: 4 })).toBe("Agreement agr_abc · v2 · Partner Review pr_xyz · v4");
  });
});
