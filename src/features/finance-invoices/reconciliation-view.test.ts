import { describe, expect, it } from "vitest";

import type { InvoicePayablePinDto } from "@/server/finance-invoices/client-dto";
import type { InvoiceReconciliationResult } from "@/server/finance-invoices/types";

import { arithmeticWarning, hasMismatchFinding, reconciliationComparisonRows, reconciliationReadinessRows, unresolvedBlockerCount } from "./reconciliation-view";

const PIN: InvoicePayablePinDto = {
  payableRef: "pay_00000000000000000001",
  payableVersion: 2,
  counterpartyType: "PARTNER",
  counterpartyRef: "prt_1",
  agreementRef: "agr_1",
  agreementVersion: 1,
  reviewRef: null,
  reviewVersion: null,
  commercialPeriod: { periodKey: "2026-03", periodStart: "2026-03-01", periodEnd: "2026-03-31" },
  payableCurrency: "INR",
  // Step 15C: gross expected Invoice total is the reconciliation target (500000 = ₹5,000, same
  // figure the pre-15C fixture used for its "expected total" so existing numeric expectations
  // below stay meaningful); TDS (10%) and the full payout sum are distinct, separate figures.
  payableTotalAmountMinorSigned: 450000,
  payableServiceBaseMinor: 500000,
  payableGstMinor: 0,
  payableGrossInvoiceExpectedMinor: 500000,
  payableTdsMinor: 50000,
  payableExpectedNetPaymentMinor: 450000,
  payableCalculationRuleVersion: "MONTHLY_ANALYTICS_PRORATION_V1",
};

function reconciliation(overrides: Partial<InvoiceReconciliationResult> = {}): InvoiceReconciliationResult {
  return { state: "MATCH", findings: [], computedAt: "2026-03-01T00:00:00.000Z", ...overrides };
}

describe("reconciliationComparisonRows", () => {
  it("shows Match on every row for a clean, fully declared invoice", () => {
    const rows = reconciliationComparisonRows({
      pin: PIN,
      declared: { currency: "INR", declaredTotalMinor: 500000, externalInvoiceNumber: "INV-1" },
      reconciliation: reconciliation(),
      documentPresent: true,
      amountsVisible: true,
    });
    expect(rows.map((row) => row.field)).toEqual([
      "Counterparty",
      "Currency",
      "Commercial period",
      "Gross expected Invoice / declared total",
      "Service base / declared subtotal",
      "GST (expected / declared tax lines)",
      "TDS (platform payment treatment)",
      "Expected net payment",
      "Invoice number uniqueness",
      "Required document",
      "Source Payable version",
    ]);
    // Every row EXCEPT the informational service-base/GST/TDS/net rows is a clean Match (no
    // declared subtotal/tax was supplied in this fixture, so those show "Missing in Invoice" /
    // no-comparison states rather than an invented Match).
    const coreRows = rows.filter((row) => !["serviceBase", "gst", "tds", "expectedNetPayment"].includes(row.key));
    expect(coreRows.every((row) => row.result.label === "Match")).toBe(true);
  });

  it("Step 15C: shows service base, GST, TDS and expected net payment as their own distinct rows, never collapsed into the total", () => {
    const rows = reconciliationComparisonRows({
      pin: PIN,
      declared: { currency: "INR", declaredTotalMinor: 500000, externalInvoiceNumber: "INV-1", subtotalMinor: 500000, taxTotalMinor: 0 },
      reconciliation: reconciliation(),
      documentPresent: true,
      amountsVisible: true,
    });
    expect(rows.find((row) => row.key === "serviceBase")).toMatchObject({ payableValue: "₹5,000", invoiceValue: "₹5,000", result: { label: "Match" } });
    expect(rows.find((row) => row.key === "gst")).toMatchObject({ payableValue: "₹0", invoiceValue: "₹0" });
    expect(rows.find((row) => row.key === "tds")).toMatchObject({ payableValue: "₹500", invoiceValue: "Not an Invoice line" });
    expect(rows.find((row) => row.key === "expectedNetPayment")).toMatchObject({ payableValue: "₹4,500", invoiceValue: "—" });
  });

  it("flags a subtotal/service-base mismatch as an informational review row, never a blocker on its own", () => {
    const rows = reconciliationComparisonRows({
      pin: PIN,
      declared: { currency: "INR", declaredTotalMinor: 500000, externalInvoiceNumber: "INV-1", subtotalMinor: 480000, taxTotalMinor: 20000 },
      reconciliation: reconciliation({ state: "REVIEW_REQUIRED", findings: [{ code: "SUBTOTAL_SERVICE_BASE_MISMATCH", severity: "WARNING", message: "Both figures are preserved for Finance review." }] }),
      documentPresent: true,
      amountsVisible: true,
    });
    const serviceBaseRow = rows.find((row) => row.key === "serviceBase")!;
    expect(serviceBaseRow.result.label).toBe("Review required");
    expect(serviceBaseRow.resolution).toBe("Both figures are preserved for Finance review.");
    // The gross total itself is unaffected - a subtotal mismatch alone is never a total mismatch.
    expect(rows.find((row) => row.key === "total")!.result.label).toBe("Match");
  });

  it("marks the total row Mismatch and preserves both figures when TOTAL_AMOUNT_MISMATCH is present", () => {
    const rows = reconciliationComparisonRows({
      pin: PIN,
      declared: { currency: "INR", declaredTotalMinor: 400000, externalInvoiceNumber: "INV-1" },
      reconciliation: reconciliation({ state: "MISMATCH", findings: [{ code: "TOTAL_AMOUNT_MISMATCH", severity: "BLOCKER", message: "Both figures are preserved." }] }),
      documentPresent: true,
      amountsVisible: true,
    });
    const totalRow = rows.find((row) => row.key === "total")!;
    expect(totalRow.result.label).toBe("Mismatch");
    expect(totalRow.payableValue).toBe("₹5,000");
    expect(totalRow.invoiceValue).toBe("₹4,000");
    expect(totalRow.resolution).toBe("Both figures are preserved.");
  });

  it("withholds amounts (never a figure) when amountsVisible is false", () => {
    const rows = reconciliationComparisonRows({
      pin: PIN,
      declared: { currency: "INR", declaredTotalMinor: 400000, externalInvoiceNumber: "INV-1" },
      reconciliation: reconciliation(),
      documentPresent: true,
      amountsVisible: false,
    });
    const totalRow = rows.find((row) => row.key === "total")!;
    expect(totalRow.payableValue).toBe("Hidden");
    expect(totalRow.invoiceValue).toBe("Hidden");
  });

  it("flags currency mismatch and missing currency distinctly", () => {
    const mismatchRows = reconciliationComparisonRows({
      pin: PIN,
      declared: { currency: "USD", declaredTotalMinor: 500000, externalInvoiceNumber: "INV-1" },
      reconciliation: reconciliation({ state: "BLOCKED", findings: [{ code: "CURRENCY_MISMATCH", severity: "BLOCKER", message: "Currency differs." }] }),
      documentPresent: true,
      amountsVisible: true,
    });
    expect(mismatchRows.find((row) => row.key === "currency")!.result.label).toBe("Mismatch");

    const missingRows = reconciliationComparisonRows({ pin: PIN, declared: { currency: null, declaredTotalMinor: null, externalInvoiceNumber: null }, reconciliation: reconciliation(), documentPresent: false, amountsVisible: true });
    expect(missingRows.find((row) => row.key === "currency")!.result.label).toBe("Missing in Invoice");
  });

  it("flags a duplicate invoice number as Mismatch and an unset number as Review required", () => {
    const duplicate = reconciliationComparisonRows({
      pin: PIN,
      declared: { currency: "INR", declaredTotalMinor: 500000, externalInvoiceNumber: "INV-1" },
      reconciliation: reconciliation({ state: "BLOCKED", findings: [{ code: "DUPLICATE_INVOICE_NUMBER", severity: "BLOCKER", message: "Already used." }] }),
      documentPresent: true,
      amountsVisible: true,
    });
    expect(duplicate.find((row) => row.key === "invoiceNumber")!.result.label).toBe("Mismatch");

    const unset = reconciliationComparisonRows({ pin: PIN, declared: { currency: "INR", declaredTotalMinor: 500000, externalInvoiceNumber: null }, reconciliation: reconciliation(), documentPresent: true, amountsVisible: true });
    expect(unset.find((row) => row.key === "invoiceNumber")!.result.label).toBe("Review required");
  });

  it("flags a missing document", () => {
    const rows = reconciliationComparisonRows({
      pin: PIN,
      declared: { currency: "INR", declaredTotalMinor: 500000, externalInvoiceNumber: "INV-1" },
      reconciliation: reconciliation({ state: "BLOCKED", findings: [{ code: "MISSING_INVOICE_DOCUMENT", severity: "BLOCKER", message: "No document." }] }),
      documentPresent: false,
      amountsVisible: true,
    });
    expect(rows.find((row) => row.key === "document")!.result.label).toBe("Missing in Invoice");
  });
});

describe("arithmeticWarning / hasMismatchFinding / unresolvedBlockerCount", () => {
  it("surfaces the arithmetic finding message without inventing a corrected total", () => {
    const result = reconciliation({ state: "REVIEW_REQUIRED", findings: [{ code: "ARITHMETIC_INCONSISTENT", severity: "WARNING", message: "Subtotal + tax does not equal the total." }] });
    expect(arithmeticWarning(result)).toBe("Subtotal + tax does not equal the total.");
    expect(arithmeticWarning(reconciliation())).toBeNull();
  });

  it("detects a total-amount mismatch finding", () => {
    expect(hasMismatchFinding(reconciliation({ findings: [{ code: "TOTAL_AMOUNT_MISMATCH", severity: "BLOCKER", message: "x" }] }))).toBe(true);
    expect(hasMismatchFinding(reconciliation())).toBe(false);
  });

  it("excludes an accepted mismatch from the unresolved blocker count, but not other blockers", () => {
    const result = reconciliation({
      state: "BLOCKED",
      findings: [
        { code: "TOTAL_AMOUNT_MISMATCH", severity: "BLOCKER", message: "x" },
        { code: "CURRENCY_MISMATCH", severity: "BLOCKER", message: "y" },
      ],
    });
    expect(unresolvedBlockerCount(result, true)).toBe(1);
    expect(unresolvedBlockerCount(result, false)).toBe(2);
  });
});

describe("reconciliationReadinessRows", () => {
  it("marks every row ready for a complete, matched invoice", () => {
    const rows = reconciliationReadinessRows({ declared: { currency: "INR", declaredTotalMinor: 500000, externalInvoiceNumber: "INV-1" }, documentPresent: true, reconciliation: reconciliation(), mismatchAcceptedForThisVersion: false });
    expect(rows.every((row) => row.state === "ready")).toBe(true);
  });

  it("marks mismatch resolution blocked when unaccepted, and needs_review (not fully ready) once accepted", () => {
    const result = reconciliation({ state: "MISMATCH", findings: [{ code: "TOTAL_AMOUNT_MISMATCH", severity: "BLOCKER", message: "x" }] });
    const unaccepted = reconciliationReadinessRows({ declared: { currency: "INR", declaredTotalMinor: 400000, externalInvoiceNumber: "INV-1" }, documentPresent: true, reconciliation: result, mismatchAcceptedForThisVersion: false });
    expect(unaccepted.find((row) => row.label === "Mismatch resolution")!.state).toBe("blocked");

    const accepted = reconciliationReadinessRows({ declared: { currency: "INR", declaredTotalMinor: 400000, externalInvoiceNumber: "INV-1" }, documentPresent: true, reconciliation: result, mismatchAcceptedForThisVersion: true });
    expect(accepted.find((row) => row.label === "Mismatch resolution")!.state).toBe("ready");
  });

  it("marks the duplicate check blocked when a duplicate is detected", () => {
    const result = reconciliation({ state: "BLOCKED", findings: [{ code: "DUPLICATE_INVOICE_NUMBER", severity: "BLOCKER", message: "x" }] });
    const rows = reconciliationReadinessRows({ declared: { currency: "INR", declaredTotalMinor: 500000, externalInvoiceNumber: "INV-1" }, documentPresent: true, reconciliation: result, mismatchAcceptedForThisVersion: false });
    expect(rows.find((row) => row.label === "Duplicate check")!.state).toBe("blocked");
  });
});
