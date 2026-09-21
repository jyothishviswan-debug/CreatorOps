import { describe, expect, it } from "vitest";

import { AGREEMENT_FIELDS, AGREEMENT_FIELD_KEYS } from "@/server/finance-agreements/fields";
import { AGREEMENT_TYPES, PAYMENT_CYCLES } from "@/server/finance-agreements/terms";
import { AGREEMENT_EVENT_KINDS, AGREEMENT_ENTRY_DECISIONS, EXTRACTION_CONFIDENCES, EXTRACTION_RUN_STATUSES } from "@/server/finance-agreements/types";
import { RECONCILIATION_STATES } from "@/server/finance-agreements/reconciliation-compare";

import {
  AGREEMENT_TYPE_LABELS,
  CONTRACT_MAX_BYTES,
  DECISION_CHIPS,
  DISABLED_BUTTON_STYLE,
  EVENT_KIND_LABELS,
  EXTRACTION_NOTE,
  FIELD_LABELS,
  KYC_AVAILABLE_NOTE,
  KYC_COMPONENT_CHIPS,
  KYC_STATE_CHIPS,
  LIFECYCLE_CHIPS,
  MASTER_DATA_SOURCE_LABEL,
  PAYMENT_CYCLE_OPTIONS,
  QUALIFYING_UNIT_OPTIONS,
  RECONCILIATION_CHIPS,
  RECONCILIATION_REASON_LABELS,
  SCAN_MANUAL_REVIEW_MESSAGE,
  TARGET_MONITORING_LABEL,
  checkContractFile,
  confidenceChip,
  extractionStatusChip,
  fieldLabel,
  formatEffectivePeriod,
  formatFileSize,
  formatMoneyMinor,
  formatPlatformList,
  formatPlatformName,
  formatUtcDate,
  groupIndianDigits,
  isSupportedQualifyingUnit,
  isUtcDate,
  minorToInputText,
  parseMoneyInputToMinor,
  paymentCycleLabel,
  qualifyingUnitLabel,
  reconciliationLabel,
  todayUtcDate,
  versionStatusChip,
} from "./format";

describe("copy constants (binding wording)", () => {
  it("carries the exact Step 14B strings", () => {
    expect(TARGET_MONITORING_LABEL).toBe("Monitoring only · does not affect payment");
    expect(EXTRACTION_NOTE).toBe("Extraction suggests values only. Review every field before confirming the Agreement.");
    expect(SCAN_MANUAL_REVIEW_MESSAGE).toBe("Manual review required — no extractable text was found.");
    expect(MASTER_DATA_SOURCE_LABEL).toBe("CreatorOps master data");
    expect(KYC_AVAILABLE_NOTE).toBe("KYC available in Partner/Vendor record");
  });
  it("has its own local visibly-disabled style (5.14:1 treatment)", () => {
    expect(DISABLED_BUTTON_STYLE).toEqual({ background: "#eceff2", borderColor: "#d5dae0", color: "#5a6572", cursor: "not-allowed" });
  });
});

describe("status chips (text always present, total over every enum)", () => {
  it("covers every lifecycle status with non-empty text", () => {
    expect(Object.keys(LIFECYCLE_CHIPS).sort()).toEqual(["ACTIVE", "DRAFT", "ENDED", "SUPERSEDED", "SUSPENDED"]);
    for (const chip of Object.values(LIFECYCLE_CHIPS)) expect(chip.label.length).toBeGreaterThan(0);
  });
  it("distinguishes a confirmed-not-active draft from an editable one", () => {
    expect(versionStatusChip({ status: "DRAFT", confirmed: false }).label).toBe("Draft");
    expect(versionStatusChip({ status: "DRAFT", confirmed: true }).label).toBe("Confirmed · not active");
    expect(versionStatusChip({ status: "ACTIVE", confirmed: true }).label).toBe("Active");
  });
  it("maps every reconciliation state to the exact human vocabulary", () => {
    expect(RECONCILIATION_STATES.map(reconciliationLabel)).toEqual(["Match", "Missing in CreatorOps", "Missing in Agreement", "Mismatch", "Not applicable", "Restricted", "Unavailable"]);
    expect(Object.keys(RECONCILIATION_CHIPS).sort()).toEqual([...RECONCILIATION_STATES].sort());
    expect(RECONCILIATION_CHIPS.MISMATCH.tone).toBe("orange");
    expect(RECONCILIATION_CHIPS.MATCH.tone).toBe("default");
  });
  it("has a human reason for every reconciliation reason code", () => {
    const codes = ["no_canonical_field", "canonical_unreadable", "canonical_value_not_comparable", "agreement_value_not_comparable", "not_applicable_to_counterparty", "decided_not_applicable", "canonical_declares_not_applicable", "nothing_to_compare", "identity_access_required"];
    expect(Object.keys(RECONCILIATION_REASON_LABELS).sort()).toEqual([...codes].sort());
  });
  it("covers every extraction status, confidence, decision and event kind", () => {
    for (const status of EXTRACTION_RUN_STATUSES) expect(extractionStatusChip(status).label.length).toBeGreaterThan(0);
    expect(extractionStatusChip("MANUAL_REVIEW_REQUIRED").label).toBe("Manual review required");
    for (const confidence of EXTRACTION_CONFIDENCES) expect(confidenceChip(confidence).label.length).toBeGreaterThan(0);
    expect(confidenceChip(null).label).toBe("Unknown");
    for (const decision of AGREEMENT_ENTRY_DECISIONS) expect(DECISION_CHIPS[decision].label.length).toBeGreaterThan(0);
    expect(DECISION_CHIPS.PENDING.label).toBe("Needs confirmation");
    for (const kind of AGREEMENT_EVENT_KINDS) expect(EVENT_KIND_LABELS[kind]).toBeTruthy();
  });
  it("covers every KYC state and component status", () => {
    expect(Object.keys(KYC_STATE_CHIPS).sort()).toEqual(["AVAILABLE", "INCOMPLETE", "MISSING", "RESTRICTED", "UNAVAILABLE"]);
    expect(KYC_COMPONENT_CHIPS.PRESENT.label).toBe("Available");
    expect(KYC_COMPONENT_CHIPS.RESTRICTED.label).toBe("Restricted");
    expect(Object.keys(KYC_COMPONENT_CHIPS).sort()).toEqual(["INCOMPLETE", "MISSING", "NOT_APPLICABLE", "PRESENT", "RESTRICTED"]);
    expect(KYC_COMPONENT_CHIPS.INCOMPLETE.label).toBe("Incomplete");
  });
});

describe("registry field labels", () => {
  it("labels every AGREEMENT_FIELDS key", () => {
    expect(Object.keys(FIELD_LABELS).sort()).toEqual([...AGREEMENT_FIELD_KEYS].sort());
    for (const field of AGREEMENT_FIELDS) expect(fieldLabel(field.key).trim().length).toBeGreaterThan(0);
  });
  it("uses the canonical terminology, never 'Fixed deliverable units' or Deliverable", () => {
    expect(fieldLabel("monthlyRequiredQualifyingContentCount")).toBe("Monthly required qualifying content");
    for (const label of Object.values(FIELD_LABELS)) expect(label).not.toMatch(/deliverable/i);
  });
});

describe("qualifying units, payment cycles, agreement types, platforms", () => {
  it("offers exactly the two supported qualifying units with their human labels", () => {
    expect(QUALIFYING_UNIT_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["approved_content_thread", "Approved Content"],
      ["approved_current_link", "Approved current link"],
    ]);
    expect(qualifyingUnitLabel("approved_content_thread")).toBe("Approved Content");
    expect(qualifyingUnitLabel("approved_current_link")).toBe("Approved current link");
  });
  it("never maps unsupported wording: it is shown as written and reported unsupported", () => {
    expect(isSupportedQualifyingUnit("reel")).toBe(false);
    expect(isSupportedQualifyingUnit("approved_content_thread")).toBe(true);
    expect(isSupportedQualifyingUnit(null)).toBe(false);
    expect(qualifyingUnitLabel("reel")).toBe("reel");
    expect(qualifyingUnitLabel(null)).toBe("—");
  });
  it("labels every payment cycle and agreement type", () => {
    expect(PAYMENT_CYCLE_OPTIONS.map((o) => o.value)).toEqual([...PAYMENT_CYCLES]);
    expect(paymentCycleLabel("ONE_TIME")).toBe("One-time");
    expect(paymentCycleLabel(null)).toBe("—");
    for (const type of AGREEMENT_TYPES) expect(AGREEMENT_TYPE_LABELS[type]).toBeTruthy();
  });
  it("formats platform names for display only", () => {
    expect(formatPlatformName("instagram")).toBe("Instagram");
    expect(formatPlatformName("youtube")).toBe("YouTube");
    expect(formatPlatformList(["instagram", "youtube"])).toBe("Instagram + YouTube");
    expect(formatPlatformList([])).toBe("—");
  });
});

describe("groupIndianDigits", () => {
  it("groups in the en-IN style", () => {
    expect(groupIndianDigits("0")).toBe("0");
    expect(groupIndianDigits("999")).toBe("999");
    expect(groupIndianDigits("1000")).toBe("1,000");
    expect(groupIndianDigits("35000")).toBe("35,000");
    expect(groupIndianDigits("100000")).toBe("1,00,000");
    expect(groupIndianDigits("1234567")).toBe("12,34,567");
    expect(groupIndianDigits("123456789")).toBe("12,34,56,789");
    expect(groupIndianDigits("90071992547409")).toBe("9,00,71,99,25,47,409");
  });
});

describe("formatMoneyMinor (integer minor units, no floats)", () => {
  it("formats rupees with en-IN grouping and hides a .00 fraction", () => {
    expect(formatMoneyMinor(0)).toBe("₹0");
    expect(formatMoneyMinor(3_500_000)).toBe("₹35,000");
    expect(formatMoneyMinor(100_000_000)).toBe("₹10,00,000");
    expect(formatMoneyMinor(123_456_700)).toBe("₹12,34,567");
  });
  it("shows a non-zero fraction and pads it", () => {
    expect(formatMoneyMinor(3_500_050)).toBe("₹35,000.50");
    expect(formatMoneyMinor(5)).toBe("₹0.05");
    expect(formatMoneyMinor(99)).toBe("₹0.99");
    expect(formatMoneyMinor(100)).toBe("₹1");
    expect(formatMoneyMinor(100, "INR", { alwaysDecimals: true })).toBe("₹1.00");
  });
  it("is exact at the safe-integer ceiling (string arithmetic)", () => {
    expect(formatMoneyMinor(Number.MAX_SAFE_INTEGER)).toBe("₹9,00,71,99,25,47,409.91");
    expect(formatMoneyMinor(Number.MAX_SAFE_INTEGER).endsWith(".91")).toBe(true);
    expect(formatMoneyMinor(Number.MAX_SAFE_INTEGER).replace(/[^\d]/g, "")).toBe("9007199254740991");
  });
  it("prefixes another currency's code", () => {
    expect(formatMoneyMinor(150_000, "USD")).toBe("USD 1,500");
    expect(formatMoneyMinor(150_000, "usd")).toBe("USD 1,500");
    expect(formatMoneyMinor(150_000, null)).toBe("₹1,500");
  });
  it("never invents a number for null, negative, fractional or unsafe input", () => {
    expect(formatMoneyMinor(null)).toBe("—");
    expect(formatMoneyMinor(undefined)).toBe("—");
    expect(formatMoneyMinor(-1)).toBe("—");
    expect(formatMoneyMinor(1.5)).toBe("—");
    expect(formatMoneyMinor(Number.NaN)).toBe("—");
    expect(formatMoneyMinor(Number.MAX_SAFE_INTEGER + 2)).toBe("—");
  });
});

describe("minorToInputText", () => {
  it("prefills without symbol or grouping", () => {
    expect(minorToInputText(3_500_000)).toBe("35000");
    expect(minorToInputText(3_500_050)).toBe("35000.50");
    expect(minorToInputText(5)).toBe("0.05");
    expect(minorToInputText(0)).toBe("0");
    expect(minorToInputText(null)).toBe("");
  });
  it("round-trips through the parser", () => {
    for (const minor of [0, 1, 99, 100, 1999, 3_500_050, 123_456_789, Number.MAX_SAFE_INTEGER]) {
      expect(parseMoneyInputToMinor(minorToInputText(minor))).toEqual({ ok: true, amountMinor: minor });
    }
  });
});

describe("parseMoneyInputToMinor (rupees text -> integer minor units, no floats)", () => {
  const ok = (text: string) => {
    const result = parseMoneyInputToMinor(text);
    if (!result.ok) throw new Error(`expected ${JSON.stringify(text)} to parse: ${result.message}`);
    return result.amountMinor;
  };
  const bad = (text: string) => {
    const result = parseMoneyInputToMinor(text);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.message;
  };

  it("parses whole rupees, grouping, symbols and spaces", () => {
    expect(ok("35000")).toBe(3_500_000);
    expect(ok("35,000")).toBe(3_500_000);
    expect(ok("₹ 3,50,000")).toBe(35_000_000);
    expect(ok("  ₹35000  ")).toBe(3_500_000);
    expect(ok("0")).toBe(0);
    expect(ok("000")).toBe(0);
    expect(ok("007")).toBe(700);
  });
  it("is immune to binary-float traps", () => {
    expect(ok("19.99")).toBe(1999); // 19.99 * 100 === 1998.9999999999998 in IEEE-754
    expect(ok("0.1")).toBe(10);
    expect(ok("0.07")).toBe(7);
    expect(ok("1.15")).toBe(115); // 1.15 * 100 === 114.99999999999999
    expect(ok("4.35")).toBe(435); // 4.35 * 100 === 434.99999999999994
    expect(ok("8.2")).toBe(820);
  });
  it("handles fractions: one digit, trailing dot, leading dot, trailing zeros beyond two places", () => {
    expect(ok("35000.5")).toBe(3_500_050);
    expect(ok("35000.50")).toBe(3_500_050);
    expect(ok("35000.")).toBe(3_500_000);
    expect(ok(".5")).toBe(50);
    expect(ok("0.05")).toBe(5);
    expect(ok("10.500")).toBe(1050);
    expect(ok("10.5000")).toBe(1050);
  });
  it("never silently rounds: a third significant decimal is rejected", () => {
    expect(bad("10.505")).toMatch(/2 decimal/);
    expect(bad("0.001")).toMatch(/2 decimal/);
    expect(bad("19.999")).toMatch(/2 decimal/);
  });
  it("rejects empty, negative, malformed and non-numeric text", () => {
    expect(bad("")).toMatch(/Enter an amount/);
    expect(bad("   ")).toMatch(/Enter an amount/);
    expect(bad("-5")).toMatch(/negative/);
    expect(bad("₹-5")).toMatch(/negative/);
    for (const text of [".", "abc", "1e5", "1.2.3", "1,,000", ",100", "100,", "12,34.5,6", "1_000", "5 000 0x", "NaN", "Infinity", "$5"]) bad(text);
  });
  it("rejects amounts beyond the safe-integer minor-unit ceiling but accepts the ceiling itself", () => {
    expect(ok("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    expect(bad("90071992547409.92")).toMatch(/too large/);
    expect(bad("99999999999999999999")).toMatch(/too large/);
  });
});

describe("dates", () => {
  it("validates calendar dates", () => {
    expect(isUtcDate("2026-09-14")).toBe(true);
    expect(isUtcDate("2026-02-30")).toBe(false);
    expect(isUtcDate("2026-9-14")).toBe(false);
    expect(isUtcDate(null)).toBe(false);
    expect(isUtcDate("2024-02-29")).toBe(true);
  });
  it("formats a calendar date from the string itself (no time-zone shift)", () => {
    expect(formatUtcDate("2026-09-14")).toBe("14 Sep 2026");
    expect(formatUtcDate("2026-01-01")).toBe("1 Jan 2026");
    expect(formatUtcDate("2026-12-31")).toBe("31 Dec 2026");
    expect(formatUtcDate(null)).toBe("—");
    expect(formatUtcDate("")).toBe("—");
    expect(formatUtcDate("not-a-date")).toBe("not-a-date");
  });
  it("formats an effective period, including open-ended and empty", () => {
    expect(formatEffectivePeriod("2026-09-01", "2027-08-31")).toBe("1 Sep 2026 – 31 Aug 2027");
    expect(formatEffectivePeriod("2026-09-01", null)).toBe("From 1 Sep 2026");
    expect(formatEffectivePeriod(null, "2027-08-31")).toBe("Until 31 Aug 2027");
    expect(formatEffectivePeriod(null, null)).toBe("—");
  });
  it("derives today's UTC date from an injectable clock", () => {
    expect(todayUtcDate(new Date("2026-09-21T23:59:59.000Z"))).toBe("2026-09-21");
    expect(todayUtcDate(new Date("2026-09-22T00:00:00.000Z"))).toBe("2026-09-22");
  });
});

describe("contract file pre-check", () => {
  it("accepts a PDF up to 10 MB", () => {
    expect(checkContractFile({ name: "agreement.pdf", size: 1024, type: "application/pdf" })).toBeNull();
    expect(checkContractFile({ name: "AGREEMENT.PDF", size: CONTRACT_MAX_BYTES, type: "application/pdf" })).toBeNull();
    expect(checkContractFile({ name: "agreement.pdf", size: 1024, type: "" })).toBeNull();
  });
  it("rejects non-PDF, empty and oversized files with a message", () => {
    expect(checkContractFile({ name: "agreement.docx", size: 1024, type: "application/msword" })).toBe("Only PDF files can be uploaded.");
    expect(checkContractFile({ name: "agreement.pdf", size: 1024, type: "image/png" })).toBe("Only PDF files can be uploaded.");
    expect(checkContractFile({ name: "agreement.pdf", size: 0, type: "application/pdf" })).toBe("This file is empty.");
    expect(checkContractFile({ name: "agreement.pdf", size: CONTRACT_MAX_BYTES + 1, type: "application/pdf" })).toMatch(/limit is 10 MB/);
  });
  it("formats file sizes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(500 * 1024)).toBe("500 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatFileSize(-1)).toBe("—");
  });
});
