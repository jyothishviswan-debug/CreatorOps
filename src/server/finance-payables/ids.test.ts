import { describe, expect, it } from "vitest";

import { deterministicPayableLineRef, generatePayableLineRef, payableBusinessKey, payableRefFor, sourceVersionRef, type PayableBusinessKeyInput } from "./ids";
import { payableLineRefSchema, payableRefSchema } from "./types";

// Step 15A sections 4 and 11: Payable identity and the idempotency/business key.

const BASIS = { counterpartyType: "PARTNER" as const, counterpartyRef: "partner-1", commercialPeriod: "2024-03" };

const KEY_INPUT: PayableBusinessKeyInput = { ...BASIS, sourceType: "PARTNER_REVIEW", agreementRef: "agr_0123456789abcdef0123", agreementVersion: 2, reviewRef: "pr_0123456789abcdef0123", reviewVersion: 1 };

describe("the canonical payable ref", () => {
  it("is deterministic in the commercial basis and matches the stored ref shape", () => {
    const ref = payableRefFor(BASIS);
    expect(payableRefFor(BASIS)).toBe(ref);
    expect(payableRefSchema.safeParse(ref).success).toBe(true);
  });

  it("differs for a different counterparty, counterparty type or period - and for nothing else", () => {
    const base = payableRefFor(BASIS);
    expect(payableRefFor({ ...BASIS, counterpartyRef: "partner-2" })).not.toBe(base);
    expect(payableRefFor({ ...BASIS, counterpartyType: "VENDOR" })).not.toBe(base);
    expect(payableRefFor({ ...BASIS, commercialPeriod: "2024-04" })).not.toBe(base);
  });

  it("does NOT vary with the source versions - that is what makes a newer source a revision of the SAME payable, never a duplicate", () => {
    expect(payableRefFor(BASIS)).toBe(payableRefFor({ counterpartyType: "PARTNER", counterpartyRef: "partner-1", commercialPeriod: "2024-03" }));
  });

  it("reveals neither the counterparty ref nor the period", () => {
    const ref = payableRefFor(BASIS);
    expect(ref).not.toContain("partner-1");
    expect(ref).not.toContain("2024-03");
  });
});

describe("the business key (section 11)", () => {
  it("is deterministic and covers counterparty, period, source type, Agreement ref/version and Review ref/version", () => {
    const base = payableBusinessKey(KEY_INPUT);
    expect(payableBusinessKey(KEY_INPUT)).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    for (const changed of [
      { counterpartyRef: "partner-2" },
      { counterpartyType: "VENDOR" as const },
      { commercialPeriod: "2024-04" },
      { sourceType: "AGREEMENT_ONLY" as const },
      { agreementRef: "agr_ffffffffffffffffffff" },
      { agreementVersion: 3 },
      { reviewRef: "pr_ffffffffffffffffffff" },
      { reviewVersion: 2 },
    ]) {
      expect(payableBusinessKey({ ...KEY_INPUT, ...changed }), JSON.stringify(changed)).not.toBe(base);
    }
  });

  it("distinguishes an absent review from a present one without collision", () => {
    expect(payableBusinessKey({ ...KEY_INPUT, reviewRef: null, reviewVersion: null })).not.toBe(payableBusinessKey(KEY_INPUT));
  });
});

describe("breakdown line refs", () => {
  it("an engine line's ref is deterministic in (payable, category, discriminator) so a version diff stays readable", () => {
    const ref = deterministicPayableLineRef("pay_00000000000000000001", "BASE_FIXED", "agreement-fixed-component");
    expect(deterministicPayableLineRef("pay_00000000000000000001", "BASE_FIXED", "agreement-fixed-component")).toBe(ref);
    expect(deterministicPayableLineRef("pay_00000000000000000001", "INCENTIVE", "agreement-fixed-component")).not.toBe(ref);
    expect(payableLineRefSchema.safeParse(ref).success).toBe(true);
  });

  it("a manual line's ref is random (a manual adjustment has no derivable identity)", () => {
    expect(generatePayableLineRef()).not.toBe(generatePayableLineRef());
    expect(payableLineRefSchema.safeParse(generatePayableLineRef()).success).toBe(true);
  });
});

describe("source version refs", () => {
  it("names the exact pinned version a line came from", () => {
    expect(sourceVersionRef("agr_0123456789abcdef0123", 2)).toBe("agr_0123456789abcdef0123@2");
  });
});
