import { describe, expect, it } from "vitest";

import { AGREEMENT_FIELD_BY_KEY, checkFieldDecisionValue, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import { AGREEMENT_TYPES, MAX_INCENTIVE_SLABS, MAX_PERFORMANCE_TARGETS } from "@/server/finance-agreements/terms";

import {
  TEXT_FIELD_LIMITS,
  buildAccountTransferFee,
  buildAdvancePayment,
  buildFixedComponent,
  buildIncentive,
  buildLfcSfc,
  buildPerformanceTargets,
  hasAnyAmount,
  previewAgreementType,
  validateCommercialTerms,
  validateCurrency,
  validateDateField,
  validateDateOrder,
  validateFieldValue,
  validatePaymentCycle,
  validatePlatforms,
  validateQualifyingCount,
  validateQualifyingUnit,
  validateEmailShape,
  validatePhoneShape,
  validateTextField,
  type IncentiveSlabDraft,
  type TextFieldKey,
} from "./terms-validators";

const ok = <T,>(result: { ok: boolean; value?: T; errors?: string[] }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  return result.value as T;
};
const errors = (result: { ok: boolean; errors?: string[] }): string[] => {
  if (result.ok) throw new Error("expected a failure");
  return result.errors ?? [];
};
// The server's own rule is the authority: whatever a builder returns must pass it.
const serverAccepts = (key: AgreementFieldKey, value: unknown) => checkFieldDecisionValue(key, "CORRECTED", value).ok;

describe("mirror of the server: text limits (no drift from terms.ts)", () => {
  for (const [key, max] of Object.entries(TEXT_FIELD_LIMITS) as Array<[TextFieldKey, number]>) {
    // The two contact fields also have a SHAPE check on the client (below), so their boundary samples are well-formed at exactly that length.
    const sample = (length: number) => (key === "emailAddress" ? `${"a".repeat(length - 5)}@b.co` : key === "contactNumber" ? `1234567${" ".repeat(length - 8)}1` : "x".repeat(length));
    it(`${key}: ${max} characters pass both, ${max + 1} fail both`, () => {
      expect(validateTextField(key, sample(max)).ok).toBe(true);
      expect(serverAccepts(key, sample(max))).toBe(true);
      expect(validateTextField(key, sample(max + 1)).ok).toBe(false);
      expect(serverAccepts(key, sample(max + 1))).toBe(false);
    });
  }
  it("the limits table covers every free-text registry field (qualifyingUnit is a supported-unit dropdown, pinCode a pattern)", () => {
    const textFields = Object.values(AGREEMENT_FIELD_BY_KEY).filter((f) => f.valueType === "text" && f.mode === "DECIDED" && !f.identityValue && f.key !== "pinCode" && f.key !== "qualifyingUnit");
    expect(Object.keys(TEXT_FIELD_LIMITS).sort()).toEqual(textFields.map((f) => f.key).sort());
  });
  it("trims, and rejects empty text with a helpful message", () => {
    expect(ok(validateTextField("counterpartyName", "  Asha  "))).toBe("Asha");
    expect(errors(validateTextField("counterpartyName", "   "))[0]).toMatch(/Enter counterparty name/);
  });
  it("PIN code is exactly six digits (as the server)", () => {
    expect(ok(validateTextField("pinCode", " 682001 "))).toBe("682001");
    for (const bad of ["68200", "6820011", "68200a", "", "  "]) {
      expect(validateTextField("pinCode", bad).ok).toBe(false);
      if (bad.trim()) expect(serverAccepts("pinCode", bad.trim())).toBe(false);
    }
  });
});

describe("dates", () => {
  it("accepts real calendar dates only", () => {
    expect(ok(validateDateField("2026-09-14"))).toBe("2026-09-14");
    for (const bad of ["", "2026-02-30", "14/09/2026", "2026-9-14", "2026-13-01"]) expect(validateDateField(bad).ok).toBe(false);
    expect(serverAccepts("effectiveDate", "2026-02-30")).toBe(false);
  });
  it("termination cannot precede the effective date", () => {
    expect(validateDateOrder("2026-09-01", "2026-08-31")).toMatch(/cannot precede/);
    expect(validateDateOrder("2026-09-01", "2026-09-01")).toBeNull();
    expect(validateDateOrder("2026-09-01", null)).toBeNull();
    expect(validateDateOrder(null, "2026-01-01")).toBeNull();
  });
});

describe("currency, payment cycle, count, unit, platforms", () => {
  it("currency: three uppercase letters (input is upper-cased)", () => {
    expect(ok(validateCurrency(" inr "))).toBe("INR");
    for (const bad of ["", "IN", "INRR", "1NR", "₹"]) expect(validateCurrency(bad).ok).toBe(false);
    expect(serverAccepts("currency", "INR")).toBe(true);
    expect(serverAccepts("currency", "inr")).toBe(false);
  });
  it("payment cycle is one of the six", () => {
    for (const cycle of ["WEEKLY", "FORTNIGHTLY", "MONTHLY", "QUARTERLY", "ONE_TIME", "OTHER"]) {
      expect(validatePaymentCycle(cycle).ok).toBe(true);
      expect(serverAccepts("paymentCycle", cycle)).toBe(true);
    }
    expect(validatePaymentCycle("DAILY").ok).toBe(false);
    expect(serverAccepts("paymentCycle", "DAILY")).toBe(false);
  });
  it("monthly required qualifying content: a whole number 0..100000", () => {
    expect(ok(validateQualifyingCount("12"))).toBe(12);
    expect(ok(validateQualifyingCount("0"))).toBe(0);
    expect(ok(validateQualifyingCount("100000"))).toBe(100_000);
    for (const bad of ["", "-1", "1.5", "1e3", "100001", "abc", "9999999999999999999"]) expect(validateQualifyingCount(bad).ok).toBe(false);
    expect(serverAccepts("monthlyRequiredQualifyingContentCount", 100_000)).toBe(true);
    expect(serverAccepts("monthlyRequiredQualifyingContentCount", 100_001)).toBe(false);
  });
  it("qualifying unit: only the two supported values", () => {
    expect(validateQualifyingUnit("approved_content_thread").ok).toBe(true);
    expect(validateQualifyingUnit("approved_current_link").ok).toBe(true);
    for (const bad of ["reel", "", "video"]) expect(validateQualifyingUnit(bad).ok).toBe(false);
  });
  it("platforms: normalized lower-case; duplicates are REJECTED (not deduped), like the server", () => {
    expect(ok(validatePlatforms([" Instagram ", "YouTube"]))).toEqual(["instagram", "youtube"]);
    expect(errors(validatePlatforms(["Instagram", "instagram"]))[0]).toMatch(/once/);
    expect(serverAccepts("platforms", ["instagram", "instagram"])).toBe(false);
    expect(validatePlatforms([]).ok).toBe(false);
    expect(validatePlatforms(["  "]).ok).toBe(false);
    expect(validatePlatforms(Array.from({ length: 21 }, (_, i) => `p${i}`)).ok).toBe(false);
  });
});

describe("money components (rupees typed -> integer minor units)", () => {
  it("fixed component: applicable needs an amount; the amount becomes integer paise", () => {
    expect(ok(buildFixedComponent({ applicable: true, amountText: "35,000" }))).toEqual({ applicable: true, amountMinor: 3_500_000 });
    expect(ok(buildFixedComponent({ applicable: true, amountText: "19.99" }))).toEqual({ applicable: true, amountMinor: 1999 });
    expect(errors(buildFixedComponent({ applicable: true, amountText: "" }))).toEqual(["Enter the fixed amount."]);
    expect(errors(buildFixedComponent({ applicable: true, amountText: "abc" }))[0]).toMatch(/Fixed amount/);
    expect(errors(buildFixedComponent({ applicable: true, amountText: "10.505" }))[0]).toMatch(/2 decimal/);
    expect(ok(buildFixedComponent({ applicable: false, amountText: "999" }))).toEqual({ applicable: false, amountMinor: null });
  });
  it("account transfer fee / advance payment: applicable needs an amount OR details; not applicable carries neither", () => {
    expect(ok(buildAccountTransferFee({ applicable: true, amountText: "500", details: "" }))).toEqual({ applicable: true, amountMinor: 50_000, details: null });
    expect(ok(buildAccountTransferFee({ applicable: true, amountText: "", details: "Charged once" }))).toEqual({ applicable: true, amountMinor: null, details: "Charged once" });
    expect(errors(buildAccountTransferFee({ applicable: true, amountText: "", details: "  " }))[0]).toMatch(/amount or its details/);
    expect(ok(buildAccountTransferFee({ applicable: false, amountText: "500", details: "x" }))).toEqual({ applicable: false, amountMinor: null, details: null });
    expect(ok(buildAdvancePayment({ applicable: true, amountText: "10000", details: "On signing" }))).toEqual({ applicable: true, details: "On signing", amountMinor: 1_000_000 });
    expect(errors(buildAdvancePayment({ applicable: true, amountText: "", details: "" }))[0]).toMatch(/amount or its details/);
    expect(ok(buildAdvancePayment({ applicable: false, amountText: "", details: "" }))).toEqual({ applicable: false, details: null, amountMinor: null });
    expect(errors(buildAdvancePayment({ applicable: true, amountText: "", details: "x".repeat(2001) }))[0]).toMatch(/at most/);
  });
  it("everything a builder returns passes the server's own value check", () => {
    expect(serverAccepts("fixedComponent", ok(buildFixedComponent({ applicable: true, amountText: "35000" })))).toBe(true);
    expect(serverAccepts("fixedComponent", ok(buildFixedComponent({ applicable: false, amountText: "" })))).toBe(true);
    expect(serverAccepts("accountTransferFee", ok(buildAccountTransferFee({ applicable: true, amountText: "500", details: "x" })))).toBe(true);
    expect(serverAccepts("advancePayment", ok(buildAdvancePayment({ applicable: true, amountText: "", details: "x" })))).toBe(true);
  });
});

describe("incentive slabs", () => {
  const slab = (over: Partial<IncentiveSlabDraft> = {}): IncentiveSlabDraft => ({ metricId: "views", lowerBoundText: "100000", upperBoundText: "500000", unit: "views", amountText: "5000", description: "", ...over });

  it("not applicable => no slabs", () => {
    expect(ok(buildIncentive({ applicable: false, slabs: [slab()] }))).toEqual({ applicable: false, slabs: [] });
  });
  it("applicable needs at least one slab", () => {
    expect(errors(buildIncentive({ applicable: true, slabs: [] }))[0]).toMatch(/at least one slab/);
  });
  it("builds slabs with auto refs, integer paise and an open-ended upper bound", () => {
    const result = ok(buildIncentive({ applicable: true, slabs: [slab(), slab({ lowerBoundText: "500000", upperBoundText: "", amountText: "7,500.50", description: "  Top band " })] }));
    expect(result.slabs).toEqual([
      { slabRef: "slab-1", metricId: "views", lowerBound: 100_000, upperBound: 500_000, unit: "views", amountMinor: 500_000, description: null },
      { slabRef: "slab-2", metricId: "views", lowerBound: 500_000, upperBound: null, unit: "views", amountMinor: 750_050, description: "Top band" },
    ]);
    expect(serverAccepts("incentive", result)).toBe(true);
  });
  it("mirrors the slab rules: upper > lower, bounds not negative, unique refs, bounded count", () => {
    expect(errors(buildIncentive({ applicable: true, slabs: [slab({ upperBoundText: "100000" })] })).join(" ")).toMatch(/upper bound must exceed/);
    expect(errors(buildIncentive({ applicable: true, slabs: [slab({ upperBoundText: "50" })] })).join(" ")).toMatch(/upper bound must exceed/);
    expect(errors(buildIncentive({ applicable: true, slabs: [slab({ lowerBoundText: "-1" })] })).join(" ")).toMatch(/lower bound/);
    expect(errors(buildIncentive({ applicable: true, slabs: [slab({ slabRef: "a" }), slab({ slabRef: "a" })] })).join(" ")).toMatch(/unique/);
    expect(errors(buildIncentive({ applicable: true, slabs: Array.from({ length: MAX_INCENTIVE_SLABS + 1 }, () => slab()) }))[0]).toMatch(/At most/);
    expect(errors(buildIncentive({ applicable: true, slabs: [slab({ metricId: "  ", unit: "", amountText: "x" })] })).length).toBeGreaterThanOrEqual(3);
  });
});

describe("LFC / SFC (explicit only)", () => {
  it("needs at least one format; a rule is never invented", () => {
    expect(errors(buildLfcSfc({ rows: [] }))[0]).toMatch(/at least one format/);
  });
  it("maps formats to LFC / SFC, optional rule ref, rejects duplicates and blanks", () => {
    const result = ok(buildLfcSfc({ ruleRef: " R1 ", rows: [{ format: "Reel", kind: "SFC" }, { format: "Video", kind: "LFC" }] }));
    expect(result).toEqual({ ruleRef: "R1", byFormat: { Reel: "SFC", Video: "LFC" } });
    expect(serverAccepts("lfcSfc", result)).toBe(true);
    expect(ok(buildLfcSfc({ rows: [{ format: "Reel", kind: "SFC" }] }))).toEqual({ byFormat: { Reel: "SFC" } });
    expect(errors(buildLfcSfc({ rows: [{ format: "Reel", kind: "SFC" }, { format: "Reel", kind: "LFC" }] }))[0]).toMatch(/more than once/);
    expect(errors(buildLfcSfc({ rows: [{ format: " ", kind: "SFC" }] }))[0]).toMatch(/enter a name/);
    expect(errors(buildLfcSfc({ rows: Array.from({ length: 41 }, (_, i) => ({ format: `f${i}`, kind: "LFC" as const })) }))[0]).toMatch(/At most 40/);
  });
});

describe("performance targets are warning-only", () => {
  it("always produce affectsPayment:false and comparison at_least - the caller cannot change either", () => {
    const rows = [
      { metricId: "views", targetValueText: "1,00,000", unit: "views" },
      { targetRef: "growth", metricId: "followerGrowth", targetValueText: "2.5", unit: "%" },
    ];
    const result = ok(buildPerformanceTargets(rows));
    expect(result).toEqual([
      { targetRef: "target-1", metricId: "views", targetValue: 100_000, unit: "views", comparison: "at_least", affectsPayment: false },
      { targetRef: "growth", metricId: "followerGrowth", targetValue: 2.5, unit: "%", comparison: "at_least", affectsPayment: false },
    ]);
    expect(result.every((target) => target.affectsPayment === false)).toBe(true);
    expect(serverAccepts("performanceTargets", result)).toBe(true);
    // even a smuggled flag on the draft row is ignored
    const smuggled = ok(buildPerformanceTargets([{ metricId: "reach", targetValueText: "5", unit: "x", affectsPayment: true } as never]));
    expect(smuggled[0]!.affectsPayment).toBe(false);
  });
  it("validates rows and the bound", () => {
    expect(ok(buildPerformanceTargets([]))).toEqual([]);
    expect(errors(buildPerformanceTargets([{ metricId: "", targetValueText: "x", unit: "" }])).length).toBeGreaterThanOrEqual(3);
    expect(errors(buildPerformanceTargets([{ targetRef: "a", metricId: "views", targetValueText: "1", unit: "v" }, { targetRef: "a", metricId: "reach", targetValueText: "1", unit: "v" }]))[0]).toMatch(/unique/);
    expect(errors(buildPerformanceTargets(Array.from({ length: MAX_PERFORMANCE_TARGETS + 1 }, (_, i) => ({ metricId: "views", targetValueText: "1", unit: "v", targetRef: `t${i}` }))))[0]).toMatch(/At most/);
  });
});

describe("validateFieldValue is the server's own check", () => {
  it("passes valid values through and explains invalid ones", () => {
    expect(ok(validateFieldValue("paymentCycle", "CORRECTED", "MONTHLY"))).toBe("MONTHLY");
    expect(errors(validateFieldValue("paymentCycle", "CORRECTED", "DAILY"))[0]).toMatch(/Invalid value for Payment cycle/);
    expect(errors(validateFieldValue("paymentCycle", "CORRECTED", undefined))[0]).toMatch(/needs a value/);
  });
  it("UNAVAILABLE / NOT_APPLICABLE carry no value; identity fields never carry a value; computed fields cannot be decided", () => {
    expect(validateFieldValue("paymentCycle", "UNAVAILABLE", "MONTHLY").ok).toBe(false);
    expect(validateFieldValue("paymentCycle", "NOT_APPLICABLE", undefined).ok).toBe(true);
    expect(validateFieldValue("panNumber", "ACCEPTED", "ABCDE1234F").ok).toBe(false);
    expect(validateFieldValue("panNumber", "CORRECTED", undefined).ok).toBe(false);
    expect(validateFieldValue("panNumber", "ACCEPTED", undefined).ok).toBe(true);
    expect(validateFieldValue("agreementType", "CORRECTED", "FIXED_ONLY").ok).toBe(false);
    expect(validateFieldValue("partnerAccountRefs", "ACCEPTED", undefined).ok).toBe(false);
  });
});

describe("cross-field rules of the commercial terms", () => {
  const base = { currency: null, fixedComponent: null, accountTransferFee: null, advancePayment: null, incentive: null, monthlyRequiredQualifyingContentCount: null, qualifyingUnit: null };

  it("any amount needs a currency", () => {
    expect(hasAnyAmount({ ...base, fixedComponent: { applicable: true, amountMinor: 100 } })).toBe(true);
    expect(hasAnyAmount({ ...base, incentive: { applicable: true, slabs: [{}] } })).toBe(true);
    expect(hasAnyAmount({ ...base, fixedComponent: { applicable: false, amountMinor: null } })).toBe(false);
    expect(validateCommercialTerms({ ...base, fixedComponent: { applicable: true, amountMinor: 100 } })).toEqual([{ fieldKey: "currency", message: "A currency is required when any amount is present." }]);
    expect(validateCommercialTerms({ ...base, currency: "INR", fixedComponent: { applicable: true, amountMinor: 100 } })).toEqual([]);
    expect(validateCommercialTerms({ ...base, advancePayment: { applicable: true, amountMinor: 5 } })).toHaveLength(1);
    expect(validateCommercialTerms({ ...base, accountTransferFee: { applicable: true, amountMinor: 5 } })).toHaveLength(1);
  });
  it("the required count and the qualifying unit go together and the unit must be supported", () => {
    expect(validateCommercialTerms({ ...base, monthlyRequiredQualifyingContentCount: 4 })).toMatchObject([{ fieldKey: "qualifyingUnit" }]);
    expect(validateCommercialTerms({ ...base, qualifyingUnit: "approved_content_thread" })).toMatchObject([{ fieldKey: "monthlyRequiredQualifyingContentCount" }]);
    expect(validateCommercialTerms({ ...base, monthlyRequiredQualifyingContentCount: 4, qualifyingUnit: "reel" })).toMatchObject([{ fieldKey: "qualifyingUnit" }]);
    expect(validateCommercialTerms({ ...base, monthlyRequiredQualifyingContentCount: 4, qualifyingUnit: "approved_current_link" })).toEqual([]);
  });
});

describe("previewAgreementType (server-derived preview only)", () => {
  it("matches the server's derivation over all eight combinations", () => {
    const seen = new Set<string>();
    for (const fixed of [false, true]) {
      for (const incentive of [false, true]) {
        for (const required of [false, true]) {
          const type = previewAgreementType({
            fixedComponent: fixed ? { applicable: true } : { applicable: false },
            incentive: incentive ? { applicable: true, slabs: [{}] } : { applicable: false, slabs: [] },
            monthlyRequiredQualifyingContentCount: required ? 4 : 0,
          });
          seen.add(type);
        }
      }
    }
    expect(seen.size).toBe(8);
    for (const type of seen) expect(AGREEMENT_TYPES).toContain(type);
    expect(previewAgreementType({ fixedComponent: null, incentive: null, monthlyRequiredQualifyingContentCount: null })).toBe("UNSPECIFIED");
    expect(previewAgreementType({ fixedComponent: { applicable: true }, incentive: null, monthlyRequiredQualifyingContentCount: null })).toBe("FIXED_ONLY");
    // an incentive that is applicable but has no slab does not count
    expect(previewAgreementType({ fixedComponent: null, incentive: { applicable: true, slabs: [] }, monthlyRequiredQualifyingContentCount: null })).toBe("UNSPECIFIED");
  });
});

describe("client-side shape checks for the contact fields (the server accepts any short text - a backend gap)", () => {
  it("email: one @, no spaces, a dotted domain", () => {
    for (const good of ["a@b.co", "  hello@samplecreator.example ", "first.last+tag@mail.example.org"]) expect(validateEmailShape(good).ok).toBe(true);
    for (const bad of ["", "nope", "a@b", "a@@b.co", "a b@c.co", "a@b..co", "@b.co", "a@.co"]) expect(validateEmailShape(bad).ok).toBe(false);
    expect(errors(validateEmailShape("nope"))[0]).toMatch(/valid email address/);
  });
  it("phone: digits with an optional leading + and separators, 7 to 15 digits", () => {
    for (const good of ["+919876543210", "+91 98765 43210", "(080) 2345-6789", "9876543210", "0802345678"]) expect(validatePhoneShape(good).ok).toBe(true);
    for (const bad of ["", "abc", "12345", "+91 98765 4321012345678", "98765-abc", "++919876543210", "98+7654321"]) expect(validatePhoneShape(bad).ok).toBe(false);
    expect(errors(validatePhoneShape("abc"))[0]).toMatch(/7 to 15 digits/);
  });
  it("validateTextField applies them to emailAddress / contactNumber only (and the server still accepts what passes)", () => {
    expect(validateTextField("emailAddress", "not an email").ok).toBe(false);
    expect(validateTextField("contactNumber", "call me").ok).toBe(false);
    expect(validateTextField("state", "Karnataka").ok).toBe(true);
    expect(validateTextField("emailAddress", "a@b.co").ok && serverAccepts("emailAddress", "a@b.co")).toBe(true);
  });
});
