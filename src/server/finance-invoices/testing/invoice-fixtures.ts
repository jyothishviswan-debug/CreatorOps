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
    payableExpectedTotalMinorSigned: 5_000_000,
    pinnedAt: "2024-04-03T00:00:00.000Z",
    ...overrides,
  });
}

export const FIXTURE_TAX_LINE: InvoiceTaxLine = { label: "GST", ratePercentBasisPoints: 1800, amountMinor: 900_000 };

export function buildReconciliationResult(overrides: Partial<InvoiceReconciliationResult> = {}): InvoiceReconciliationResult {
  return invoiceReconciliationResultSchema.parse({ state: "MATCH", findings: [], computedAt: "2024-04-03T00:00:00.000Z", ...overrides });
}
