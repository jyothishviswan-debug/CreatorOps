import { describe, expect, it } from "vitest";

import { determinePayableAmount, openReviewCodesOf, totalOfLines } from "./amount-determination";
import { buildSnapshot, buildVendorSnapshot, FIXTURE_PAYABLE_REF } from "./testing/payable-fixtures";
import type { PayableLine } from "./types";

// Step 15A section 19 (Determination): the conservative-rules contract of the amount engine.
// Every case here is about ONE question - does the engine calculate something the confirmed
// Agreement terms explicitly support, or does it hand the decision to Finance untouched?

const determine = (snapshot: Parameters<typeof determinePayableAmount>[0]) => determinePayableAmount(snapshot, FIXTURE_PAYABLE_REF);

describe("deterministic cases", () => {
  it("a fixed amount with no other commercial term is DETERMINISTIC and pays exactly that amount", () => {
    const result = determine(buildSnapshot());
    expect(result.state).toBe("DETERMINISTIC");
    expect(result.unresolved).toEqual([]);
    expect(result.lines.map((line) => [line.category, line.amountMinorSigned])).toEqual([["BASE_FIXED", 5_000_000]]);
    expect(totalOfLines(result.lines)).toBe(5_000_000);
    expect(result.lines[0]!.source).toBe("AGREEMENT");
    expect(result.lines[0]!.sourceRef).toBe("agr_0123456789abcdef0123@2");
  });

  it("a non-applicable fixed component contributes no line at all (it is never defaulted to zero-with-a-line)", () => {
    const result = determine(buildSnapshot({ fixedComponent: { applicable: false, amountMinor: null } }));
    expect(result.lines).toEqual([]);
    expect(result.state).toBe("DETERMINISTIC");
  });

  it("is pure: the same snapshot always produces the same breakdown, line refs included", () => {
    const snapshot = buildSnapshot();
    expect(determine(snapshot)).toEqual(determine(snapshot));
  });
});

describe("no silent under-delivery penalty", () => {
  it("missed content obligations raise a named Finance item and change the amount by exactly zero", () => {
    const result = determine(
      buildSnapshot({ qualifyingContent: { requiredCount: 8, qualifyingUnit: "approved_content_thread", actualQualifyingCount: 3, variance: -5, evaluation: "below_requirement", affectsPayment: true } }),
    );
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(result.unresolved.map((item) => item.code)).toEqual(["UNDER_DELIVERY_NO_STATED_CONSEQUENCE"]);
    // The fixed fee is untouched: not prorated (5/8ths), not zeroed, not deducted.
    expect(totalOfLines(result.lines)).toBe(5_000_000);
    expect(result.lines.filter((line) => line.amountMinorSigned < 0)).toEqual([]);
  });

  it("exceeding the requirement pays no bonus of its own either", () => {
    const result = determine(
      buildSnapshot({ qualifyingContent: { requiredCount: 8, qualifyingUnit: "approved_content_thread", actualQualifyingCount: 12, variance: 4, evaluation: "exceeded", affectsPayment: true } }),
    );
    expect(result.state).toBe("DETERMINISTIC");
    expect(totalOfLines(result.lines)).toBe(5_000_000);
  });
});

describe("performance targets never change an amount", () => {
  it("a missed target leaves the total identical to the same snapshot with no targets at all", () => {
    const targets = [
      { targetRef: "t-1", metricId: "followerGrowth", targetValue: 1000, unit: "followers", actualValue: 10, evaluation: "not_met" as const, affectsPayment: false as const },
      { targetRef: "t-2", metricId: "views", targetValue: 500_000, unit: "views", actualValue: 900_000, evaluation: "met" as const, affectsPayment: false as const },
    ];
    const withTargets = determine(buildSnapshot({ performanceTargets: targets }));
    const withoutTargets = determine(buildSnapshot());
    expect(totalOfLines(withTargets.lines)).toBe(totalOfLines(withoutTargets.lines));
    expect(withTargets.state).toBe("DETERMINISTIC");
    // A target alone never produces an INCENTIVE line - only an explicit Agreement slab can.
    expect(withTargets.lines.some((line) => line.category === "INCENTIVE")).toBe(false);
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
      ["BASE_FIXED", 5_000_000],
      ["INCENTIVE", 250_000],
    ]);
    expect(totalOfLines(result.lines)).toBe(5_250_000);
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
    expect(totalOfLines(result.lines)).toBe(5_000_000);
  });
});

describe("unsupported/ambiguous advance and transfer fee => FINANCE_REVIEW_REQUIRED", () => {
  it("an applicable advance is never amortised, split or recovered automatically", () => {
    const result = determine(buildSnapshot({ advancePayment: { applicable: true, amountMinor: 2_000_000, details: "An advance of 20,000 was paid on signing." } }));
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(result.unresolved.map((item) => item.code)).toEqual(["ADVANCE_APPLICATION_UNSPECIFIED"]);
    expect(result.lines.some((line) => line.category === "ADVANCE_ADJUSTMENT")).toBe(false);
    expect(totalOfLines(result.lines)).toBe(5_000_000);
  });

  it("an applicable transfer fee ticked WITH a stated amount is added deterministically, same shape as the fixed component", () => {
    const result = determine(buildSnapshot({ accountTransferFee: { applicable: true, amountMinor: 50_000, details: "Borne by the Service Provider." } }));
    expect(result.state).toBe("DETERMINISTIC");
    expect(result.unresolved).toEqual([]);
    const line = result.lines.find((l) => l.category === "TRANSFER_FEE");
    expect(line?.amountMinorSigned).toBe(50_000);
    expect(line?.reason).toContain("Borne by the Service Provider.");
    expect(totalOfLines(result.lines)).toBe(5_050_000);
  });

  it("an applicable transfer fee ticked WITHOUT a stated amount stays Finance-review (there is no number to use)", () => {
    const result = determine(buildSnapshot({ accountTransferFee: { applicable: true, amountMinor: null, details: null } }));
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(result.unresolved.map((item) => item.code)).toEqual(["TRANSFER_FEE_APPLICATION_UNSPECIFIED"]);
    expect(result.lines.some((line) => line.category === "TRANSFER_FEE")).toBe(false);
    expect(totalOfLines(result.lines)).toBe(5_000_000);
  });

  it("a non-applicable advance or transfer fee raises nothing", () => {
    const result = determine(buildSnapshot({ advancePayment: { applicable: false, amountMinor: null, details: null }, accountTransferFee: { applicable: false, amountMinor: null, details: null } }));
    expect(result.state).toBe("DETERMINISTIC");
  });
});

describe("missing currency => BLOCKED", () => {
  it("blocks with a named reason and produces no line at all", () => {
    const result = determine(buildSnapshot({ currency: null, fixedComponent: { applicable: false, amountMinor: null }, accountTransferFee: null, advancePayment: null, incentive: null }));
    expect(result.state).toBe("BLOCKED");
    expect(result.blocked.map((item) => item.code)).toEqual(["CURRENCY_MISSING"]);
    expect(result.lines).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});

describe("agreement-only (Vendor) payables", () => {
  it("determine from the Agreement alone, with no Partner Review evidence", () => {
    const result = determine(buildVendorSnapshot());
    expect(result.state).toBe("DETERMINISTIC");
    expect(totalOfLines(result.lines)).toBe(5_000_000);
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

  it("the determination STATE is never changed by a manual adjustment - only what is still open is", () => {
    const result = determine(buildSnapshot({ accountTransferFee: { applicable: true, amountMinor: null, details: null } }));
    expect(result.state).toBe("FINANCE_REVIEW_REQUIRED");
    expect(totalOfLines([...result.lines, manual("TRANSFER_FEE_APPLICATION_UNSPECIFIED")])).toBe(4_950_000);
  });
});
