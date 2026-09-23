import {
  invoiceReconciliationResultSchema,
  type CommercialPeriod,
  type InvoiceCounterpartyType,
  type InvoicePayablePin,
  type InvoiceReconciliationFinding,
  type InvoiceReconciliationResult,
  type InvoiceTaxLine,
} from "./types";

// Step 16A section 11: RECONCILIATION - a Payable/Invoice comparison, computed FRESH on every
// version and every explicit reconcile call. Pure and deterministic (unit-tested without
// Firestore): given the invoice's own declared fields, the pinned Payable evidence, and three
// pre-computed booleans the caller supplies (duplicate-number lookup and document presence live in
// Firestore, and the Payable revision comparison lives in source-revision.ts - none of that belongs
// inside a pure function), it returns the closed-state reconciliation result.
//
// Nothing here invents tax, guesses a jurisdiction, or silently changes either amount - see
// section 9's "capture, do not invent" discipline. An amount mismatch is always a named finding,
// never a silent correction; a section 16 mismatch override does not change this function's
// output, it is recorded on the Invoice HEAD as its own decision (see invoice-lifecycle-service.ts).

export type ReconcileDeclaredInput = {
  currency: string | null;
  subtotalMinor: number | null;
  taxLines: InvoiceTaxLine[];
  declaredTotalMinor: number | null;
  externalInvoiceNumber: string | null;
  counterpartyType: InvoiceCounterpartyType;
  counterpartyRef: string;
  commercialPeriod: CommercialPeriod;
};

export type ReconcileInvoiceInput = {
  declared: ReconcileDeclaredInput;
  pin: InvoicePayablePin;
  documentPresent: boolean;
  documentRequired: boolean;
  // True when the normalized invoice number is already claimed by a DIFFERENT canonical Invoice
  // head (never by this same head - a revision under the same head is never its own duplicate).
  duplicateNumberDetected: boolean;
};

function taxTotalOf(taxLines: InvoiceTaxLine[]): number {
  return taxLines.reduce((sum, line) => sum + line.amountMinor, 0);
}

export function reconcileInvoiceAgainstPayable(input: ReconcileInvoiceInput, now: () => Date = () => new Date()): InvoiceReconciliationResult {
  const { declared, pin } = input;
  const findings: InvoiceReconciliationFinding[] = [];

  const totalMissing = declared.declaredTotalMinor === null;
  // Step 15C: the Invoice reconciles against the Payable's GROSS EXPECTED INVOICE TOTAL
  // (serviceBase + GST), never the after-TDS expected net payment (section 18/23) - TDS is
  // CreatorOps payment treatment, not part of what the supplier's own Invoice states. Null exactly
  // when the pinned Payable has no computed service base at all (e.g. no fixed component applies).
  const payableTotalMissing = pin.payableGrossInvoiceExpectedMinor === null || pin.payableGrossInvoiceExpectedMinor === undefined;

  if (totalMissing) findings.push({ code: "MISSING_INVOICE_TOTAL", severity: "BLOCKER", message: "The Invoice states no declared total yet." });
  if (payableTotalMissing) findings.push({ code: "MISSING_PAYABLE_TOTAL", severity: "BLOCKER", message: "The pinned Payable has no expected gross Invoice total." });

  if (declared.currency !== null && declared.currency !== pin.payableCurrency) {
    findings.push({ code: "CURRENCY_MISMATCH", severity: "BLOCKER", message: `The Invoice declares ${declared.currency}, but the pinned Payable is in ${pin.payableCurrency}.` });
  }
  if (declared.counterpartyType !== pin.counterpartyType || declared.counterpartyRef !== pin.counterpartyRef) {
    findings.push({ code: "COUNTERPARTY_MISMATCH", severity: "BLOCKER", message: "The Invoice's counterparty does not match the pinned Payable's counterparty." });
  }
  if (declared.commercialPeriod.periodKey !== pin.commercialPeriod.periodKey) {
    findings.push({ code: "COMMERCIAL_PERIOD_MISMATCH", severity: "BLOCKER", message: "The Invoice's commercial period does not match the pinned Payable's commercial period." });
  }
  if (!totalMissing && !payableTotalMissing && declared.declaredTotalMinor !== pin.payableGrossInvoiceExpectedMinor) {
    findings.push({
      code: "TOTAL_AMOUNT_MISMATCH",
      severity: "BLOCKER",
      message: `The Invoice declares a total that does not match the pinned Payable's gross expected Invoice total (service base + GST). Both figures are preserved; an authorized Finance actor may accept the mismatch with a reason. TDS is separate payment treatment and is never part of this comparison.`,
    });
  }
  if (input.duplicateNumberDetected) {
    findings.push({ code: "DUPLICATE_INVOICE_NUMBER", severity: "BLOCKER", message: "This supplier invoice number is already used by a different Invoice for this counterparty." });
  }
  if (input.documentRequired && !input.documentPresent) {
    findings.push({ code: "MISSING_INVOICE_DOCUMENT", severity: "BLOCKER", message: "No original Invoice document has been attached yet." });
  }
  if (declared.subtotalMinor !== null && declared.declaredTotalMinor !== null) {
    const arithmetic = declared.subtotalMinor + taxTotalOf(declared.taxLines);
    if (arithmetic !== declared.declaredTotalMinor) {
      // Deliberately no amount figure in the message text - a reconciliation finding is readable by
      // any actor who can view the Invoice, regardless of whether they hold finance_amounts.
      findings.push({ code: "ARITHMETIC_INCONSISTENT", severity: "WARNING", message: "The declared subtotal plus tax lines does not equal the declared total. Both are preserved exactly as declared." });
    }
  }
  // Step 15C section 20: informational only - the supplier's own subtotal/tax split is theirs to
  // state, so a mismatch against the Payable's service base is a WARNING for Finance to review,
  // never a BLOCKER (unlike the gross total, which the Invoice document must match).
  if (declared.subtotalMinor !== null && pin.payableServiceBaseMinor !== null && pin.payableServiceBaseMinor !== undefined && declared.subtotalMinor !== pin.payableServiceBaseMinor) {
    findings.push({
      code: "SUBTOTAL_SERVICE_BASE_MISMATCH",
      severity: "WARNING",
      message: "The Invoice's declared subtotal does not match the Payable's prorated service base. Both figures are preserved for Finance review.",
    });
  }

  const hasBlocker = (code: (typeof findings)[number]["code"]) => findings.some((finding) => finding.code === code);
  const otherBlockers = findings.some((finding) => finding.severity === "BLOCKER" && finding.code !== "TOTAL_AMOUNT_MISMATCH" && finding.code !== "MISSING_INVOICE_TOTAL" && finding.code !== "MISSING_PAYABLE_TOTAL");

  const state = totalMissing
    ? "MISSING_IN_INVOICE"
    : payableTotalMissing
      ? "MISSING_IN_PAYABLE"
      : otherBlockers
        ? "BLOCKED"
        : hasBlocker("TOTAL_AMOUNT_MISMATCH")
          ? "MISMATCH"
          : findings.some((finding) => finding.severity === "WARNING")
            ? "REVIEW_REQUIRED"
            : "MATCH";

  return invoiceReconciliationResultSchema.parse({ state, findings, computedAt: now().toISOString() });
}
