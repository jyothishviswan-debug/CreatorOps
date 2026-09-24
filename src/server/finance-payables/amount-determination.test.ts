import { describe, expect, it } from "vitest";

import { determinePayableAmount, openReviewCodesOf, totalOfLines } from "./amount-determination";
import { buildSnapshot, buildVendorSnapshot, FIXTURE_PAYABLE_REF } from "./testing/payable-fixtures";
import { CURRENT_PAYABLE_CALCULATION_RULE_VERSION, type PayableLine } from "./types";

// Step 15A/15C: the calculation-rules contract of the amount engine.
//
// Two governing questions, unchanged since Step 15A:
//   1. Does the engine calculate something the confirmed Agreement terms (plus, for the base, the
//      pinned Review's evaluated monthly evidence - Step 15C) explicitly support, or does it hand
//      the decision to Finance untouched?
//   2. Is every rounding step deterministic and reproducible (money.test.ts covers the arithmetic
//      itself in isolation; this file covers the engine wiring it into a breakdown)?
//
// The default `buildSnapshot()` fixture is a Partner-Review-sourced basis with 8 of 8 required
// qualifying content delivered (evaluation "met"), so proration is a no-op (cappedActualCount ==
// requiredCount) and the service base equals the full fixed amount - this keeps the "nothing else
// is going on" cases readable. TDS (10%, per the fixture's own default tax input) DOES apply by
// default now - every total below accounts for it explicitly, this is the corrected behavior.

const determine = (snapshot: Parameters<typeof determinePayableAmount>[0]) => determinePayableAmount(snapshot, FIXTURE_PAYABLE_REF);

describe("deterministic base cases", () => {
  it("full delivery (8 of 8): PRORATED_BASE equals the fixed amount, TDS 10% applies, gross/net are distinct from the base", () => {
    const result = determine(buildSnapshot());
    expect(result.state).toBe("DETERMINISTIC");
    expect(result.unresolved).toEqual([]);
    expect(result.lines.map((line) => [line.category, line.amountMinorSigned])).toEqual([
      ["PRORATED_BASE", 5_000_000],
      ["TDS", -500_000],
    ]);
    expect(result.serviceBaseMinor).toBe(5_000_000);
    expect(result.gstMinor).toBe(0);
    expect(result.grossInvoiceExpectedMinor).toBe(5_000_000);
    expect(result.tdsMinor).toBe(500_000);
    expect(result.expectedNetPaymentMinor).toBe(4_500_000);
    expect(totalOfLines(result.lines)).toBe(4_500_000);
    expect(result.calculationRuleVersion).toBe(CURRENT_PAYABLE_CALCULATION_RULE_VERSION);
    expect(result.calculationRuleVersion).toBe("MONTHLY_ANALYTICS_PRORATION_V1");
    const base = result.lines.find((line) => line.category === "PRORATED_BASE")!;
    expect(base.source).toBe("PARTNER_REVIEW");
    expect(base.sourceRef).toBe("pr_0123456789abcdef0123@1");
    const tds = result.lines.find((line) => line.category === "TDS")!;
    expect(tds.source).toBe("PLATFORM_RULE");
  });

  it("a non-applicable fixed component contributes no base line, and no tax either (nothing to tax)", () => {
    const result = determine(buildSnapshot({ fixedComponent: { applicable: false, amountMinor: null } }));
    expect(result.lines).toEqual([]);
    expect(result.state).toBe("DETERMINISTIC");
    expect(result.serviceBaseMinor).toBeNull();
    expect(result.grossInvoiceExpectedMinor).toBeNull();
    expect(result.expectedNetPaymentMinor).toBeNull();
  });

  it("is pure: the same snapshot always produces the same breakdown, line refs and totals included", () => {
    const snapshot = buildSnapshot();
    expect(determine(snapshot)).toEqual(determine(snapshot));
  });
});

describe("proration (Step 15C section 4-6)", () => {
  it("actual < required: the documented example (10,000,000 * 16/20 = 8,000,000)", () => {
    const result = determine(
      buildSnapshot({
        fixedComponent: { applicable: true, amountMinor: 10_000_000 },
        qualifyingContent: { requiredCount: 20, qualifyingUnit: "approved_content_thread", actualQualifyingCount: 16, variance: -4, evaluation: "below_requirement", affectsPayment: true },
      }),
    );
    expect(result.state).toBe("DETERMINISTIC");
    expect(result.serviceBaseMinor).toBe(8_000_000);
    expect(result.tdsMinor).toBe(800_000);
    expect(result.expectedNetPaymentMinor).toBe(7_200_000);
    expect(result.warnings.join(" ")).toMatch(/under-delivered.*16 of 20/);
    // Under-delivery is now a fully deterministic, already-reflected proration - never a review item.
    expect(result.unresolved).toEqual([]);
  });

  it("actual == required: the service base equals the full fixed amount, no cap note", () => {
    const result = determine(buildSnapshot());
    const base = result.lines.find((line) => line.category === "PRORATED_BASE")!;
    expect(base.label).not.toMatch(/delivered/);
    expect(result.serviceBaseMinor).toBe(5_000_000);
  });

  it("actual > required: caps at the required count, preserves BOTH the true delivered count and the capped count", () => {
    const result = determine(
      buildSnapshot({ qualifyingContent: { requiredCount: 8, qualifyingUnit: "approved_content_thread", actualQualifyingCount: 12, variance: 4, evaluation: "exceeded", affectsPayment: true } }),
    );
    expect(result.serviceBaseMinor).toBe(5_000_000); // capped at requiredCount=8, not 12
    const base = result.lines.find((line) => line.category === "PRORATED_BASE")!;
    expect(base.label).toContain("12 delivered · 8 counted for payable");
    expect(result.warnings.join(" ")).toMatch(/exceeded the monthly requirement/);
  });

  it("zero actual: the service base and every tax line are exactly zero, never negative or withheld", () => {
    const result = determine(
      buildSnapshot({ qualifyingContent: { requiredCount: 8, qualifyingUnit: "approved_content_thread", actualQualifyingCount: 0, variance: -8, evaluation: "below_requirement", affectsPayment: true } }),
    );
    expect(result.serviceBaseMinor).toBe(0);
    expect(result.tdsMinor).toBe(0);
    expect(result.grossInvoiceExpectedMinor).toBe(0);
    expect(result.expectedNetPaymentMinor).toBe(0);
    expect(result.lines.map((line) => line.category)).toEqual(["PRORATED_BASE"]); // no TDS/GST line when the base is zero
  });

  it("fractional minor-unit rounding: 100 * 1/3 rounds half-up to 33", () => {
    const result = determine(
      buildSnapshot({
        fixedComponent: { applicable: true, amountMinor: 100 },
        qualifyingContent: { requiredCount: 3, qualifyingUnit: "approved_content_thread", actualQualifyingCount: 1, variance: -2, evaluation: "below_requirement", affectsPayment: true },
      }),
    );
    expect(result.serviceBaseMinor).toBe(33);
  });

  it("missing required count - no requirement stated at all: applies the fixed amount in full (BASE_FIXED, not PRORATED_BASE) - this is expected, not a gap", () => {
    const result = determine(buildSnapshot({ qualifyingContent: null, requiredContentWithoutEvidence: false }));
    expect(result.state).toBe("DETERMINISTIC");
    expect(result.lines.map((line) => line.category)).toEqual(["BASE_FIXED", "TDS"]);
    expect(result.serviceBaseMinor).toBe(5_000_000);
  });

  it("missing required count - a requirement IS stated but the pinned Review has no evaluated evidence: proration cannot run blind, Finance must confirm", () => {
    const result = determine(buildSnapshot({ qualifyingContent: null, requiredContentWithoutEvidence: true }));
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(result.unresolved.map((item) => item.code)).toEqual(["REQUIRED_COUNT_EVIDENCE_MISSING_FOR_PRORATION"]);
    expect(result.lines).toEqual([]); // no amount is guessed
    expect(result.serviceBaseMinor).toBeNull();
  });

  it("a Vendor (AGREEMENT_ONLY) basis has no monthly evidence chain to prorate against - full fixed amount, unprorated, exactly as Step 15A", () => {
    const result = determine(buildVendorSnapshot());
    expect(result.state).toBe("DETERMINISTIC");
    expect(result.lines.map((line) => line.category)).toEqual(["BASE_FIXED"]); // no TDS - the fixture's Vendor tax input is not applicable
    expect(result.serviceBaseMinor).toBe(5_000_000);
    expect(result.tdsMinor).toBe(0);
    expect(totalOfLines(result.lines)).toBe(5_000_000);
  });

  // Step 15C section 6's "derive the total from LFC + SFC" branch is NOT implemented: this
  // repo's confirmed Agreement commercial terms (src/server/finance-agreements/terms.ts,
  // lfcSfcSchema) carry ONLY a format -> LFC/SFC classification RULE, never a separate confirmed
  // required-LFC or required-SFC quantity distinct from the single total
  // (monthlyRequiredQualifyingContentCount / contentObligations). There is no real data to derive
  // a total FROM - inventing one would violate "never guess". Documented here rather than left
  // silently unimplemented.
  it("LFC+SFC-derived required count is intentionally not supported (no such confirmed field exists in this Agreement schema)", () => {
    expect(true).toBe(true);
  });
});

describe("LFC/SFC classification (Step 15C section 7) - warning-only, never a price weight", () => {
  it("an unclassified remainder in the pinned evidence is surfaced as a warning, never a deduction", () => {
    const result = determine(buildSnapshot({ lfcSfc: { ruleRef: "rule-1", qualifyingUnit: "approved_content_thread", lfcCount: 5, sfcCount: 2, unclassifiedCount: 1 } }));
    expect(result.warnings.join(" ")).toMatch(/1 approved_content_thread could not be classified as LFC or SFC/);
    expect(result.state).toBe("DETERMINISTIC"); // a warning, not a review item
    expect(result.serviceBaseMinor).toBe(5_000_000); // unaffected
  });

  it("no LFC/SFC evidence at all raises no warning (there is nothing incomplete to flag)", () => {
    const result = determine(buildSnapshot({ lfcSfc: null }));
    expect(result.warnings).toEqual([]);
  });

  // A required-LFC-vs-actual-LFC (and SFC) SHORTFALL comparison is intentionally not implemented
  // for the same reason as the proration derivation above: the Agreement's lfcSfc term is a
  // classification RULE (which format counts as which), never a required LFC/SFC quantity to
  // compare the evidence's actual counts against. Fabricating a "required" number would violate
  // "never guess a count from narrative wording."
});

describe("monthly performance targets (Step 15C section 8) - warning-only, never affects payment", () => {
  it("a missed target and unavailable evidence both produce a plain warning and leave the total identical to no targets at all", () => {
    const targets = [
      { targetRef: "t-1", metricId: "followerGrowth", targetValue: 1000, unit: "followers", actualValue: 10, evaluation: "not_met" as const, affectsPayment: false as const },
      { targetRef: "t-2", metricId: "reach", targetValue: 500_000, unit: "reach", actualValue: null, evaluation: "unavailable" as const, affectsPayment: false as const },
      { targetRef: "t-3", metricId: "views", targetValue: 500_000, unit: "views", actualValue: 900_000, evaluation: "met" as const, affectsPayment: false as const },
    ];
    const withTargets = determine(buildSnapshot({ performanceTargets: targets }));
    const withoutTargets = determine(buildSnapshot());
    expect(totalOfLines(withTargets.lines)).toBe(totalOfLines(withoutTargets.lines));
    expect(withTargets.state).toBe("DETERMINISTIC");
    expect(withTargets.warnings.join(" ")).toMatch(/Monthly target missed: followerGrowth/);
    expect(withTargets.warnings.join(" ")).toMatch(/Monthly target evidence unavailable: reach/);
    expect(withTargets.warnings.join(" ")).not.toMatch(/views/); // a MET target gets no warning
    // A target alone never produces an INCENTIVE line - only an explicit Agreement slab can.
    expect(withTargets.lines.some((line) => line.category === "INCENTIVE")).toBe(false);
  });
});

describe("tax: TDS (Step 15C section 9)", () => {
  it("TDS 10% is withheld on the service base, as a signed-negative line, separate from GST", () => {
    const result = determine(buildSnapshot());
    const tds = result.lines.find((line) => line.category === "TDS")!;
    expect(tds.amountMinorSigned).toBe(-500_000);
    expect(tds.reason).toMatch(/platform payment treatment, separate from any Invoice-declared total/);
  });

  it("TDS not applicable (Vendor basis): no TDS line, tdsMinor is 0 not null", () => {
    const result = determine(buildVendorSnapshot());
    expect(result.lines.some((line) => line.category === "TDS")).toBe(false);
    expect(result.tdsMinor).toBe(0);
  });

  it("TDS applicable but rate unknown => Finance review required, never a guessed rate", () => {
    const result = determine(buildSnapshot({ tax: { tdsApplicable: true, tdsRateBps: null, tdsProvenance: "test-unknown-rate", gstApplicable: false, gstRateBps: null, gstProvenance: "NOT_CONFIGURED" } }));
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(result.unresolved.map((item) => item.code)).toEqual(["TDS_RATE_UNKNOWN"]);
    expect(result.tdsMinor).toBe(0);
    expect(result.lines.some((line) => line.category === "TDS")).toBe(false);
  });
});

describe("tax: GST (Step 15C section 9)", () => {
  it("GST not applicable by default: gstMinor is 0, gross Invoice expected equals the service base exactly", () => {
    const result = determine(buildSnapshot());
    expect(result.gstMinor).toBe(0);
    expect(result.grossInvoiceExpectedMinor).toBe(result.serviceBaseMinor);
  });

  it("GST applicable with a known rate: calculated on the service base, added to (not compounded with) TDS's own basis", () => {
    const result = determine(buildSnapshot({ tax: { tdsApplicable: true, tdsRateBps: 1000, tdsProvenance: "test", gstApplicable: true, gstRateBps: 1800, gstProvenance: "test-confirmed-18pct" } }));
    expect(result.state).toBe("DETERMINISTIC");
    expect(result.serviceBaseMinor).toBe(5_000_000);
    expect(result.gstMinor).toBe(900_000); // 18% of 5,000,000
    expect(result.tdsMinor).toBe(500_000); // 10% of 5,000,000 - the SAME base, not gst-inclusive
    expect(result.grossInvoiceExpectedMinor).toBe(5_900_000); // serviceBase + gst
    expect(result.expectedNetPaymentMinor).toBe(5_400_000); // serviceBase + gst - tds
    expect(totalOfLines(result.lines)).toBe(5_400_000);
    // Gross Invoice total and net payment are never the same figure once GST applies.
    expect(result.grossInvoiceExpectedMinor).not.toBe(result.expectedNetPaymentMinor);
  });

  it("GST applicable but rate unknown => Finance review required, gross Invoice total is unresolved rather than guessed", () => {
    const result = determine(buildSnapshot({ tax: { tdsApplicable: true, tdsRateBps: 1000, tdsProvenance: "test", gstApplicable: true, gstRateBps: null, gstProvenance: "test-unresolved" } }));
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(result.unresolved.map((item) => item.code)).toEqual(["GST_RATE_UNKNOWN"]);
    expect(result.gstMinor).toBe(0);
    expect(result.grossInvoiceExpectedMinor).toBe(result.serviceBaseMinor); // 0 GST assumed only for the running total, never silently invented as non-zero
    expect(result.tdsMinor).toBe(500_000); // TDS is independent and still resolves
  });

  // Step 15C.1 section 10: applicability ITSELF (gstApplicable === null) is a third state, distinct
  // from "confirmed not applicable" (false). It must never be silently treated as "No" - it raises
  // its OWN named review code, separate from GST_RATE_UNKNOWN (which only ever fires once
  // applicability is already known to be Yes).
  it("GST applicability unconfirmed (null) => Finance review required with its own named code, never silently 'No'", () => {
    const result = determine(buildSnapshot({ tax: { tdsApplicable: true, tdsRateBps: 1000, tdsProvenance: "test", gstApplicable: null, gstRateBps: null, gstProvenance: "UNCONFIRMED_NO_CANONICAL_SOURCE" } }));
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(result.unresolved.map((item) => item.code)).toEqual(["GST_APPLICABILITY_UNCONFIRMED"]);
    expect(result.gstMinor).toBe(0);
    expect(result.grossInvoiceExpectedMinor).toBe(result.serviceBaseMinor);
    expect(result.tdsMinor).toBe(500_000); // TDS is independent and still resolves even while GST is unconfirmed
  });

  it("GST confirmed NOT applicable (false, not null) => deterministic, no review item at all", () => {
    const result = determine(buildSnapshot({ tax: { tdsApplicable: true, tdsRateBps: 1000, tdsProvenance: "test", gstApplicable: false, gstRateBps: null, gstProvenance: "FINANCE_CONFIRMED" } }));
    expect(result.state).toBe("DETERMINISTIC");
    expect(result.unresolved).toEqual([]);
    expect(result.gstMinor).toBe(0);
    expect(result.grossInvoiceExpectedMinor).toBe(result.serviceBaseMinor);
  });
});

describe("explicit supported incentive calculation", () => {
  const slab = { slabRef: "slab-1", metricId: "views", lowerBound: 100_000, upperBound: 500_000, unit: "views", amountMinor: 250_000 };

  it("pays the one matching slab when the metric is measured and the threshold is unambiguous", () => {
    const result = determine(
      buildSnapshot({
        incentive: { applicable: true, narrative: null, slabs: [slab] },
        performanceTargets: [{ targetRef: "t-1", metricId: "views", targetValue: 100_000, unit: "views", actualValue: 300_000, evaluation: "met", affectsPayment: false }],
      }),
    );
    expect(result.state).toBe("DETERMINISTIC");
    expect(result.lines.map((line) => [line.category, line.amountMinorSigned])).toEqual([
      ["PRORATED_BASE", 5_000_000],
      ["TDS", -500_000],
      ["INCENTIVE", 250_000],
    ]);
    // Incentive is NOT part of the tax basis (section 11) - service base and its derived totals stay identical.
    expect(result.serviceBaseMinor).toBe(5_000_000);
    expect(result.tdsMinor).toBe(500_000);
    expect(totalOfLines(result.lines)).toBe(4_750_000);
  });

  it("pays nothing, with a warning and no Finance item, when the measurement is below every slab", () => {
    const result = determine(
      buildSnapshot({
        incentive: { applicable: true, narrative: null, slabs: [slab] },
        performanceTargets: [{ targetRef: "t-1", metricId: "views", targetValue: 100_000, unit: "views", actualValue: 5_000, evaluation: "not_met", affectsPayment: false }],
      }),
    );
    expect(result.state).toBe("DETERMINISTIC");
    expect(result.lines.some((line) => line.category === "INCENTIVE")).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/below the lowest slab/);
  });

  it("requires Finance when the metric is not measured at all", () => {
    const result = determine(buildSnapshot({ incentive: { applicable: true, narrative: null, slabs: [slab] } }));
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(result.unresolved.map((item) => item.code)).toEqual(["INCENTIVE_METRIC_EVIDENCE_MISSING"]);
    expect(result.lines.some((line) => line.category === "INCENTIVE")).toBe(false);
  });

  it("requires Finance when the metric is reported as unavailable", () => {
    const result = determine(
      buildSnapshot({
        incentive: { applicable: true, narrative: null, slabs: [slab] },
        performanceTargets: [{ targetRef: "t-1", metricId: "views", targetValue: 100_000, unit: "views", actualValue: null, evaluation: "unavailable", affectsPayment: false }],
      }),
    );
    expect(result.unresolved.map((item) => item.code)).toEqual(["INCENTIVE_METRIC_EVIDENCE_MISSING"]);
  });

  it("requires Finance when two slabs of one metric both match", () => {
    const result = determine(
      buildSnapshot({
        incentive: { applicable: true, narrative: null, slabs: [slab, { slabRef: "slab-2", metricId: "views", lowerBound: 200_000, upperBound: 800_000, unit: "views", amountMinor: 400_000 }] },
        performanceTargets: [{ targetRef: "t-1", metricId: "views", targetValue: 100_000, unit: "views", actualValue: 300_000, evaluation: "met", affectsPayment: false }],
      }),
    );
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(result.unresolved.map((item) => item.code)).toEqual(["INCENTIVE_THRESHOLD_AMBIGUOUS"]);
    expect(result.lines.some((line) => line.category === "INCENTIVE")).toBe(false);
  });

  it("requires Finance when the measurement falls in a gap between slabs", () => {
    const result = determine(
      buildSnapshot({
        incentive: { applicable: true, narrative: null, slabs: [slab, { slabRef: "slab-2", metricId: "views", lowerBound: 900_000, upperBound: null, unit: "views", amountMinor: 900_000 }] },
        performanceTargets: [{ targetRef: "t-1", metricId: "views", targetValue: 100_000, unit: "views", actualValue: 700_000, evaluation: "met", affectsPayment: false }],
      }),
    );
    expect(result.unresolved.map((item) => item.code)).toEqual(["INCENTIVE_THRESHOLD_AMBIGUOUS"]);
  });
});

describe("narrative incentive => FINANCE_REVIEW_REQUIRED", () => {
  it("a discretionary clause is never turned into an amount", () => {
    const result = determine(buildSnapshot({ incentive: { applicable: true, narrative: "An additional performance bonus may be paid at the Company's discretion.", slabs: [] } }));
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(result.unresolved.map((item) => item.code)).toEqual(["NARRATIVE_INCENTIVE"]);
    expect(totalOfLines(result.lines)).toBe(4_500_000); // base 5,000,000 - TDS 500,000; the incentive itself is still unresolved
  });
});

describe("unsupported/ambiguous advance and transfer fee => FINANCE_REVIEW_REQUIRED", () => {
  it("an applicable advance is never amortised, split or recovered automatically", () => {
    const result = determine(buildSnapshot({ advancePayment: { applicable: true, amountMinor: 2_000_000, details: "An advance of 20,000 was paid on signing." } }));
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(result.unresolved.map((item) => item.code)).toEqual(["ADVANCE_APPLICATION_UNSPECIFIED"]);
    expect(result.lines.some((line) => line.category === "ADVANCE_ADJUSTMENT")).toBe(false);
    expect(totalOfLines(result.lines)).toBe(4_500_000);
  });

  it("an applicable transfer fee ticked WITH a stated amount is added deterministically, kept OUTSIDE the GST/TDS basis (section 11)", () => {
    const result = determine(buildSnapshot({ accountTransferFee: { applicable: true, amountMinor: 50_000, details: "Borne by the Service Provider." } }));
    expect(result.state).toBe("DETERMINISTIC");
    expect(result.unresolved).toEqual([]);
    const line = result.lines.find((l) => l.category === "TRANSFER_FEE");
    expect(line?.amountMinorSigned).toBe(50_000);
    expect(line?.reason).toContain("Borne by the Service Provider.");
    // The transfer fee affects the full payout sum (totalOfLines)...
    expect(totalOfLines(result.lines)).toBe(4_550_000);
    // ...but NOT the tax-formula totals, which stay tied to the service base alone.
    expect(result.tdsMinor).toBe(500_000);
    expect(result.expectedNetPaymentMinor).toBe(4_500_000);
    expect(result.warnings.join(" ")).toMatch(/transfer fee's GST\/TDS tax-basis interaction is not defined/);
  });

  it("an applicable transfer fee ticked WITHOUT a stated amount stays Finance-review (there is no number to use)", () => {
    const result = determine(buildSnapshot({ accountTransferFee: { applicable: true, amountMinor: null, details: null } }));
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(result.unresolved.map((item) => item.code)).toEqual(["TRANSFER_FEE_APPLICATION_UNSPECIFIED"]);
    expect(result.lines.some((line) => line.category === "TRANSFER_FEE")).toBe(false);
    expect(totalOfLines(result.lines)).toBe(4_500_000);
  });

  it("a non-applicable advance or transfer fee raises nothing", () => {
    const result = determine(buildSnapshot({ advancePayment: { applicable: false, amountMinor: null, details: null }, accountTransferFee: { applicable: false, amountMinor: null, details: null } }));
    expect(result.state).toBe("DETERMINISTIC");
  });
});

describe("missing currency => BLOCKED", () => {
  it("blocks with a named reason and produces no line, no totals, at all", () => {
    const result = determine(buildSnapshot({ currency: null, fixedComponent: { applicable: false, amountMinor: null }, accountTransferFee: null, advancePayment: null, incentive: null }));
    expect(result.state).toBe("BLOCKED");
    expect(result.blocked.map((item) => item.code)).toEqual(["CURRENCY_MISSING"]);
    expect(result.lines).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.serviceBaseMinor).toBeNull();
    expect(result.grossInvoiceExpectedMinor).toBeNull();
    expect(result.expectedNetPaymentMinor).toBeNull();
  });
});

describe("open review codes", () => {
  const manual = (resolvesCode: string | null): PayableLine => ({
    lineRef: "pl_00000000000000000001",
    label: "Transfer fee",
    category: "MANUAL_ADJUSTMENT",
    amountMinorSigned: -50_000,
    source: "MANUAL",
    sourceRef: null,
    reason: "Finance confirmed the transfer fee is borne by the partner.",
    actor: { userRef: "user-1", at: "2024-04-04T00:00:00.000Z" },
    resolvesCode,
  });

  it("a manual adjustment naming a review item closes it; one that names nothing does not", () => {
    // Ticked applicable with NO stated amount - still the genuinely ambiguous case (a stated amount
    // is now deterministic, see the describe block above).
    const result = determine(buildSnapshot({ accountTransferFee: { applicable: true, amountMinor: null, details: null } }));
    expect(openReviewCodesOf(result.unresolved, [...result.lines, manual(null)])).toEqual(["TRANSFER_FEE_APPLICATION_UNSPECIFIED"]);
    expect(openReviewCodesOf(result.unresolved, [...result.lines, manual("TRANSFER_FEE_APPLICATION_UNSPECIFIED")])).toEqual([]);
  });

  it("the determination STATE is never changed by a manual adjustment - only what is still open is; the tax totals never change from a manual line either", () => {
    const result = determine(buildSnapshot({ accountTransferFee: { applicable: true, amountMinor: null, details: null } }));
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(totalOfLines([...result.lines, manual("TRANSFER_FEE_APPLICATION_UNSPECIFIED")])).toBe(4_450_000);
    expect(result.serviceBaseMinor).toBe(5_000_000);
    expect(result.tdsMinor).toBe(500_000);
  });
});
