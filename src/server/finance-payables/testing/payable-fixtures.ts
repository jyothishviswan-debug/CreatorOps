import { payableSourceSnapshotSchema, SNAPSHOT_SCHEMA_VERSION, type PayableSourceSnapshot } from "../types";

// Step 15A: synthetic evidence fixtures shared by the Payables unit tests. Every value is
// invented. The base snapshot is the simplest fully-determined case: a Partner-review payable with
// a fixed component, delivery met, no transfer fee, no advance and no incentive.

export const FIXTURE_PAYABLE_REF = "pay_00000000000000000001";

export type SnapshotOverrides = Partial<PayableSourceSnapshot>;

export function buildSnapshot(overrides: SnapshotOverrides = {}): PayableSourceSnapshot {
  return payableSourceSnapshotSchema.parse({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    counterparty: { type: "PARTNER", ref: "partner-fixture" },
    commercialPeriod: { periodKey: "2024-03", periodStart: "2024-03-01", periodEnd: "2024-03-31" },
    sourceType: "PARTNER_REVIEW",
    agreement: { agreementRef: "agr_0123456789abcdef0123", agreementVersion: 2, agreementType: "FIXED_PLUS_REQUIRED_CONTENT", effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31" },
    review: { reviewRef: "pr_0123456789abcdef0123", reviewVersion: 1, finalizedAt: "2024-04-02T00:00:00.000Z", sourceFingerprint: "a".repeat(64) },
    currency: "INR",
    qualifyingContent: { requiredCount: 8, qualifyingUnit: "approved_content_thread", actualQualifyingCount: 8, variance: 0, evaluation: "met", affectsPayment: true },
    requiredContentWithoutEvidence: false,
    lfcSfc: null,
    contentObligations: [],
    fixedComponent: { applicable: true, amountMinor: 5_000_000 },
    accountTransferFee: null,
    advancePayment: null,
    incentive: null,
    paymentTerms: { paymentCycle: "MONTHLY", invoiceRequired: true, invoiceDueTerms: "Invoice by the 5th of the following month", paymentDueTerms: "Payment within 30 days of invoice" },
    performanceTargets: [],
    // Step 15C: the CreatorOps product TDS rule, matching source-evidence.ts's own default for a
    // Partner-Review-sourced basis. GST has no confirmed source in this repo yet (see
    // types.ts's snapshotTaxSchema doc comment) - always not-applicable unless a test overrides it.
    tax: { tdsApplicable: true, tdsRateBps: 1000, tdsProvenance: "PLATFORM_PRODUCT_RULE_TDS_V1", gstApplicable: false, gstRateBps: null, gstProvenance: "NOT_CONFIGURED" },
    warnings: [],
    capturedAt: "2024-04-03T00:00:00.000Z",
    ...overrides,
  });
}

// The same shape with a Vendor, agreement-only source (no Partner Review evidence at all). No TDS
// product rule is extended to a Vendor basis without an explicit confirmed source (source-evidence.ts).
export function buildVendorSnapshot(overrides: SnapshotOverrides = {}): PayableSourceSnapshot {
  return buildSnapshot({
    counterparty: { type: "VENDOR", ref: "vendor-fixture" },
    sourceType: "AGREEMENT_ONLY",
    review: null,
    qualifyingContent: null,
    tax: { tdsApplicable: false, tdsRateBps: null, tdsProvenance: "NOT_APPLICABLE_AGREEMENT_ONLY_BASIS", gstApplicable: false, gstRateBps: null, gstProvenance: "NOT_CONFIGURED" },
    ...overrides,
  });
}
