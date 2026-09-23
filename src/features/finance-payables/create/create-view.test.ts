import { describe, expect, it } from "vitest";

import type { PayableLineDto, PayableSnapshotDto, PayableSourcePreviewDto } from "@/server/finance-payables/client-dto";

import { agreementEvidenceSection, breakdownRows, calculationSummaryRows, canCreatePayable, confirmReadiness, performanceTargetsSection, reviewEvidenceSection, sourceEvidenceSummary, sourceReadiness, warningsList } from "./create-view";

function line(overrides: Partial<PayableLineDto> = {}): PayableLineDto {
  return { lineRef: "pl_1", label: "Fixed component", category: "BASE_FIXED", amountMinorSigned: 5000000, source: "AGREEMENT", sourceRef: "agr_abc@2", reason: "Fixed component per Agreement", actorUserRef: null, actorAt: null, resolvesCode: null, ...overrides };
}

function preview(overrides: Partial<PayableSourcePreviewDto> = {}): PayableSourcePreviewDto {
  return {
    counterparty: { type: "PARTNER", ref: "partner-1", displayName: "Nila Talks" },
    commercialPeriod: { periodKey: "2026-03", periodStart: "2026-03-01", periodEnd: "2026-03-31" },
    sourceType: "PARTNER_REVIEW",
    agreementRef: "agr_abc",
    agreementVersion: 2,
    reviewRef: "pr_xyz",
    reviewVersion: 3,
    snapshot: null,
    determinationState: "DETERMINISTIC",
    unresolved: [],
    blockers: [],
    warnings: [],
    lines: [line()],
    totalAmountMinorSigned: 5000000,
    currency: "INR",
    amountsVisible: true,
    existingPayableRef: null,
    serviceBaseMinor: 5000000,
    gstMinor: 0,
    grossInvoiceExpectedMinor: 5000000,
    tdsMinor: 500000,
    expectedNetPaymentMinor: 4500000,
    calculationRuleVersion: "MONTHLY_ANALYTICS_PRORATION_V1",
    ...overrides,
  };
}

describe("sourceReadiness", () => {
  it("cannot continue with no preview yet", () => {
    expect(sourceReadiness(null)).toEqual({ canContinue: false, blocked: false, blockerMessages: [], reviewMessages: [] });
  });

  it("allows continue when DETERMINISTIC", () => {
    expect(sourceReadiness(preview()).canContinue).toBe(true);
  });

  it("allows continue when FINANCE_REVIEW_REQUIRED (the backend permits a DRAFT with open items)", () => {
    const result = sourceReadiness(preview({ determinationState: "FINANCE_REVIEW_REQUIRED", unresolved: [{ code: "NARRATIVE_INCENTIVE", message: "Discretionary incentive language.", sourceRef: null }] }));
    expect(result.canContinue).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.reviewMessages).toEqual(["Discretionary incentive language."]);
  });

  it("cannot continue when BLOCKED, and surfaces the exact backend blocker messages", () => {
    const result = sourceReadiness(preview({ determinationState: "BLOCKED", lines: [], totalAmountMinorSigned: null, currency: null, blockers: [{ code: "CURRENCY_MISSING", message: "The Agreement states no currency, so no amount can be determined." }] }));
    expect(result.canContinue).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.blockerMessages).toEqual(["The Agreement states no currency, so no amount can be determined."]);
  });
});

describe("sourceEvidenceSummary", () => {
  it("names the pinned Agreement, Partner Review, period and currency", () => {
    const rows = sourceEvidenceSummary(preview());
    expect(rows).toContainEqual({ label: "Agreement", value: "agr_abc · v2" });
    expect(rows).toContainEqual({ label: "Partner Review", value: "pr_xyz · v3" });
    expect(rows).toContainEqual({ label: "Commercial period", value: "2026-03" });
    expect(rows).toContainEqual({ label: "Currency", value: "INR" });
  });

  it("names an existing canonical Payable for the same basis when one exists", () => {
    const rows = sourceEvidenceSummary(preview({ existingPayableRef: "pay_00000000000000000009" }));
    expect(rows).toContainEqual({ label: "Existing Payable", value: "pay_00000000000000000009" });
  });
});

describe("breakdownRows - transfer fee, incentive, under-delivery, manual adjustment", () => {
  it("renders an auto-determined transfer fee as a Calculated line, never a review item", () => {
    const rows = breakdownRows({
      lines: [line({ lineRef: "pl_fee", category: "TRANSFER_FEE", label: "Account transfer fee", amountMinorSigned: 25000, reason: "Account transfer fee per Agreement" })],
      unresolved: [],
      currency: "INR",
      amountsVisible: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "line", component: "Transfer fee", status: { label: "Calculated" } });
  });

  it("renders an unresolved transfer fee (no stated amount) as a Needs Finance review row with the backend's own message", () => {
    const rows = breakdownRows({ lines: [], unresolved: [{ code: "TRANSFER_FEE_APPLICATION_UNSPECIFIED", message: "The Agreement ticks the transfer fee applicable but states no amount.", sourceRef: "agr_abc@2" }], currency: "INR", amountsVisible: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "unresolved", component: "Transfer fee", basis: "The Agreement ticks the transfer fee applicable but states no amount.", status: { label: "Needs Finance review" }, amountText: "—" });
  });

  it("renders a narrative incentive as Needs Finance review, never silently calculated", () => {
    const rows = breakdownRows({ lines: [], unresolved: [{ code: "NARRATIVE_INCENTIVE", message: "The Agreement states a discretionary incentive with no structured schedule.", sourceRef: null }], currency: "INR", amountsVisible: true });
    expect(rows[0]).toMatchObject({ kind: "unresolved", component: "Incentive", status: { label: "Needs Finance review" } });
  });

  it("renders a deterministic structured incentive slab as a Calculated line", () => {
    const rows = breakdownRows({ lines: [line({ lineRef: "pl_inc", category: "INCENTIVE", reason: "Incentive slab matched" })], unresolved: [], currency: "INR", amountsVisible: true });
    expect(rows[0]).toMatchObject({ kind: "line", component: "Incentive", status: { label: "Calculated" } });
  });

  it("renders under-delivery as an informational review item, never a deduction line", () => {
    const rows = breakdownRows({ lines: [], unresolved: [{ code: "UNDER_DELIVERY_NO_STATED_CONSEQUENCE", message: "Qualifying content was under-delivered and the Agreement states no payment consequence.", sourceRef: null }], currency: "INR", amountsVisible: true });
    expect(rows[0].amountText).toBe("—");
    expect(rows[0]).toMatchObject({ component: "Qualifying content" });
  });

  it("marks a MANUAL_ADJUSTMENT line as manual", () => {
    const rows = breakdownRows({ lines: [line({ lineRef: "pl_manual", category: "MANUAL_ADJUSTMENT", source: "MANUAL", reason: "Finance-confirmed adjustment" })], unresolved: [], currency: "INR", amountsVisible: true });
    expect(rows[0]).toMatchObject({ kind: "line", manual: true });
  });

  it("shows 'Hidden' for a line's amount when amountsVisible is false", () => {
    const rows = breakdownRows({ lines: [line({ amountMinorSigned: null })], unresolved: [], currency: "INR", amountsVisible: false });
    expect(rows[0].amountText).toBe("Hidden");
  });
});

describe("performanceTargetsSection", () => {
  it("is null when there are no performance targets", () => {
    expect(performanceTargetsSection(baseSnapshot())).toBeNull();
  });

  it("labels performance targets as monitoring-only, never as part of the amount", () => {
    const section = performanceTargetsSection(baseSnapshot({ performanceTargets: [{ targetRef: "t1", metricId: "engagement_rate", targetValue: 5, unit: "%", actualValue: 6, evaluation: "met", affectsPayment: false }] }));
    expect(section?.title).toContain("Monitoring only");
    expect(section?.title).toContain("does not affect payment");
  });
});

describe("agreementEvidenceSection / reviewEvidenceSection", () => {
  it("names the pinned Agreement ref and version", () => {
    const section = agreementEvidenceSection(baseSnapshot());
    expect(section.rows).toContainEqual({ label: "Agreement", value: "agr_abc · v2" });
  });

  it("is null for an agreement-only (Vendor) snapshot with no Review", () => {
    expect(reviewEvidenceSection(baseSnapshot({ review: null }))).toBeNull();
  });

  it("names the finalized Partner Review (the Monthly Analytics evidence pin) and its qualifying-content actual vs required", () => {
    const section = reviewEvidenceSection(baseSnapshot());
    expect(section?.title).toContain("Monthly Analytics");
    expect(section?.rows).toContainEqual({ label: "Qualifying deliverable count", value: "8 of 8 approved_content_thread" });
  });

  it("surfaces an unclassified LFC/SFC remainder in the evidence row", () => {
    const section = reviewEvidenceSection(baseSnapshot({ lfcSfc: { ruleRef: "rule-1", qualifyingUnit: "approved_content_thread", lfcCount: 5, sfcCount: 2, unclassifiedCount: 1 } }));
    expect(section?.rows).toContainEqual({ label: "LFC / SFC (actual)", value: "5 LFC · 2 SFC · 1 unclassified" });
  });
});

describe("calculationSummaryRows (Step 15C)", () => {
  it("lists the full calculation chain in order: Agreement amount, required, delivered, counted, service base, GST, gross, TDS, net", () => {
    const rows = calculationSummaryRows({
      snapshot: baseSnapshot({ qualifyingContent: { requiredCount: 20, qualifyingUnit: "approved_content_thread", actualQualifyingCount: 16, variance: -4, evaluation: "below_requirement", affectsPayment: true } }),
      totals: { serviceBaseMinor: 8_000_000, gstMinor: 0, grossInvoiceExpectedMinor: 8_000_000, tdsMinor: 800_000, expectedNetPaymentMinor: 7_200_000 },
      currency: "INR",
      amountsVisible: true,
    });
    expect(rows.map((row) => row.label)).toEqual([
      "Agreement monthly amount",
      "Required monthly deliverables",
      "Monthly Analytics delivered",
      "Counted for payable",
      "Prorated service base",
      "GST",
      "Gross expected Invoice",
      "TDS",
      "Expected net payment",
    ]);
    expect(rows.find((row) => row.label === "Counted for payable")?.value).toBe("16 approved_content_thread");
  });

  it("shows the '24 delivered · 20 counted' wording when capped", () => {
    const rows = calculationSummaryRows({
      snapshot: baseSnapshot({ qualifyingContent: { requiredCount: 20, qualifyingUnit: "approved_content_thread", actualQualifyingCount: 24, variance: 4, evaluation: "exceeded", affectsPayment: true } }),
      totals: { serviceBaseMinor: 5_000_000, gstMinor: 0, grossInvoiceExpectedMinor: 5_000_000, tdsMinor: 500_000, expectedNetPaymentMinor: 4_500_000 },
      currency: "INR",
      amountsVisible: true,
    });
    expect(rows.find((row) => row.label === "Counted for payable")?.value).toBe("24 delivered · 20 counted for payable");
  });

  it("withholds every money value (not the counts) when amountsVisible is false", () => {
    const rows = calculationSummaryRows({
      snapshot: baseSnapshot(),
      totals: { serviceBaseMinor: null, gstMinor: null, grossInvoiceExpectedMinor: null, tdsMinor: null, expectedNetPaymentMinor: null },
      currency: "INR",
      amountsVisible: false,
    });
    expect(rows.find((row) => row.label === "Prorated service base")?.value).toBe("Hidden");
    expect(rows.find((row) => row.label === "Required monthly deliverables")?.value).toBe("8 approved_content_thread");
  });
});

describe("warningsList", () => {
  it("passes through the snapshot's own warnings verbatim", () => {
    expect(warningsList(baseSnapshot({ warnings: ["Advance ambiguity noted."] }))).toEqual(["Advance ambiguity noted."]);
  });
});

describe("confirmReadiness / canCreatePayable", () => {
  it("every item is met for a fully deterministic preview", () => {
    const items = confirmReadiness(preview());
    expect(items.every((item) => item.met)).toBe(true);
  });

  it("Finance review items resolved is false when unresolved items remain", () => {
    const items = confirmReadiness(preview({ determinationState: "FINANCE_REVIEW_REQUIRED", unresolved: [{ code: "NARRATIVE_INCENTIVE", message: "x", sourceRef: null }] }));
    expect(items.find((item) => item.label === "Finance review items resolved")?.met).toBe(false);
  });

  it("canCreatePayable is false only when BLOCKED", () => {
    expect(canCreatePayable(null)).toBe(false);
    expect(canCreatePayable(preview({ determinationState: "BLOCKED" }))).toBe(false);
    expect(canCreatePayable(preview({ determinationState: "FINANCE_REVIEW_REQUIRED" }))).toBe(true);
    expect(canCreatePayable(preview({ determinationState: "DETERMINISTIC" }))).toBe(true);
  });
});

function baseSnapshot(overrides: Partial<PayableSnapshotDto> = {}): PayableSnapshotDto {
  return {
    schemaVersion: 1,
    counterparty: { type: "PARTNER", ref: "partner-1" },
    commercialPeriod: { periodKey: "2026-03", periodStart: "2026-03-01", periodEnd: "2026-03-31" },
    sourceType: "PARTNER_REVIEW",
    agreement: { agreementRef: "agr_abc", agreementVersion: 2, agreementType: "FIXED_PLUS_REQUIRED_CONTENT", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" },
    review: { reviewRef: "pr_xyz", reviewVersion: 3, finalizedAt: "2026-04-01T00:00:00.000Z", sourceFingerprint: "a".repeat(64) },
    currency: "INR",
    qualifyingContent: { requiredCount: 8, qualifyingUnit: "approved_content_thread", actualQualifyingCount: 8, variance: 0, evaluation: "met", affectsPayment: true },
    requiredContentWithoutEvidence: false,
    lfcSfc: null,
    contentObligations: [],
    fixedComponent: { applicable: true, amountMinor: 5000000 },
    accountTransferFee: null,
    advancePayment: null,
    incentive: null,
    paymentTerms: { paymentCycle: "MONTHLY", invoiceRequired: true, invoiceDueTerms: null, paymentDueTerms: null },
    performanceTargets: [],
    tax: { tdsApplicable: true, tdsRateBps: 1000, tdsProvenance: "PLATFORM_PRODUCT_RULE_TDS_V1", gstApplicable: false, gstRateBps: null, gstProvenance: "NOT_CONFIGURED" },
    warnings: [],
    capturedAt: "2026-04-02T00:00:00.000Z",
    ...overrides,
  };
}
