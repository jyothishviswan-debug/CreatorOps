import { invoicePayablePinSchema, invoiceReconciliationResultSchema, type InvoicePayablePin, type InvoiceReconciliationResult, type InvoiceTaxLine } from "../types";

// Step 16A: synthetic evidence fixtures shared by the Invoices unit tests. Every value is invented.

export const FIXTURE_INVOICE_REF = "inv_00000000000000000001";

export type PinOverrides = Partial<InvoicePayablePin>;

export function buildPin(overrides: PinOverrides = {}): InvoicePayablePin {
  return invoicePayablePinSchema.parse({
    payableRef: "pay_0123456789abcdef0123",
    payableVersion: 1,
    counterpartyType: "PARTNER",
    counterpartyRef: "partner-fixture",
    agreementRef: "agr_0123456789abcdef0123",
    agreementVersion: 1,
    reviewRef: "pr_0123456789abcdef0123",
    reviewVersion: 1,
    commercialPeriod: { periodKey: "2024-03", periodStart: "2024-03-01", periodEnd: "2024-03-31" },
    payableCurrency: "INR",
    // Step 15C: the five distinct tax/proration totals, plus the full payout sum kept as
    // read-only context (see finance-payables/testing/payable-fixtures.ts's own default: a fully
    // delivered 5,000,000 base with the CreatorOps 10% TDS rule applied and no GST).
    payableTotalAmountMinorSigned: 4_500_000,
    payableServiceBaseMinor: 5_000_000,
    payableGstMinor: 0,
    payableGrossInvoiceExpectedMinor: 5_000_000,
    payableTdsMinor: 500_000,
    payableExpectedNetPaymentMinor: 4_500_000,
    payableCalculationRuleVersion: "MONTHLY_ANALYTICS_PRORATION_V1",
    pinnedAt: "2024-04-03T00:00:00.000Z",
    ...overrides,
  });
}

export const FIXTURE_TAX_LINE: InvoiceTaxLine = { label: "GST", ratePercentBasisPoints: 1800, amountMinor: 900_000 };

export function buildReconciliationResult(overrides: Partial<InvoiceReconciliationResult> = {}): InvoiceReconciliationResult {
  return invoiceReconciliationResultSchema.parse({ state: "MATCH", findings: [], computedAt: "2024-04-03T00:00:00.000Z", ...overrides });
}
