import { describe, expect, it } from "vitest";

import type { PayableLineDto, PayableSnapshotDto, PayableSourcePreviewDto } from "@/server/finance-payables/client-dto";

import { agreementEvidenceSection, breakdownRows, canCreatePayable, confirmReadiness, performanceTargetsSection, reviewEvidenceSection, sourceEvidenceSummary, sourceReadiness, warningsList } from "./create-view";

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

  it("names the finalized Partner Review and its qualifying-content actual vs required", () => {
    const section = reviewEvidenceSection(baseSnapshot());
    expect(section?.rows).toContainEqual({ label: "Qualifying content", value: "8 of 8 approved_content_thread" });
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
    lfcSfc: null,
    contentObligations: [],
    fixedComponent: { applicable: true, amountMinor: 5000000 },
    accountTransferFee: null,
    advancePayment: null,
    incentive: null,
    paymentTerms: { paymentCycle: "MONTHLY", invoiceRequired: true, invoiceDueTerms: null, paymentDueTerms: null },
    performanceTargets: [],
    warnings: [],
    capturedAt: "2026-04-02T00:00:00.000Z",
    ...overrides,
  };
}
