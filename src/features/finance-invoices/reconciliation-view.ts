// Step 16B: the PURE view/adapter logic behind the Reconciliation comparison table and readiness
// panel. Shared between the Create wizard's Stage 3 and the Invoice detail's Reconciliation tab, so
// the two screens can never disagree about what a given reconciliation result means. Nothing here
// calls the network, invents an amount, or recomputes what the server already decided (section 11:
// human labels only, never a raw enum/camelCase code).
import type { InvoicePayablePinDto, InvoicePayeeIdentityDto } from "@/server/finance-invoices/client-dto";
import type { InvoiceReconciliationResult } from "@/server/finance-invoices/types";

import { commercialPeriodLabel, counterpartyTypeLabel, formatMoneyMinor, formatSignedMoneyMinor, payeeIdentityFieldChip, payeeIdentityFieldLabel, payeeIdentityOverallChip, type ChipSpec } from "./format";

export type ReconciliationDeclared = {
  currency: string | null;
  declaredTotalMinor: number | null;
  externalInvoiceNumber: string | null;
  // Step 15C: the declared subtotal and tax-lines total, for the informational service-base/GST
  // comparison rows below. Both optional so existing callers that don't yet track them keep working.
  subtotalMinor?: number | null;
  taxTotalMinor?: number | null;
};

export type ComparisonResult = "MATCH" | "MISMATCH" | "MISSING_IN_INVOICE" | "MISSING_IN_PAYABLE" | "REVIEW_REQUIRED" | "BLOCKED";

const RESULT_CHIPS: Record<ComparisonResult, ChipSpec> = {
  MATCH: { label: "Match", tone: "default" },
  MISMATCH: { label: "Mismatch", tone: "orange" },
  MISSING_IN_INVOICE: { label: "Missing in Invoice", tone: "gray" },
  MISSING_IN_PAYABLE: { label: "Missing in Payable", tone: "gray" },
  REVIEW_REQUIRED: { label: "Review required", tone: "orange" },
  BLOCKED: { label: "Blocked", tone: "red" },
};

export type ComparisonRow = { key: string; field: string; payableValue: string; invoiceValue: string; result: ChipSpec; resolution: string };

function findingFor(reconciliation: InvoiceReconciliationResult, code: string) {
  return reconciliation.findings.find((finding) => finding.code === code) ?? null;
}

export function reconciliationComparisonRows(input: {
  pin: InvoicePayablePinDto;
  declared: ReconciliationDeclared;
  reconciliation: InvoiceReconciliationResult;
  documentPresent: boolean;
  amountsVisible: boolean;
}): ComparisonRow[] {
  const { pin, declared, reconciliation, documentPresent, amountsVisible } = input;
  const currencyFinding = findingFor(reconciliation, "CURRENCY_MISMATCH");
  const counterpartyFinding = findingFor(reconciliation, "COUNTERPARTY_MISMATCH");
  const periodFinding = findingFor(reconciliation, "COMMERCIAL_PERIOD_MISMATCH");
  const totalFinding = findingFor(reconciliation, "TOTAL_AMOUNT_MISMATCH");
  const missingInvoiceTotal = findingFor(reconciliation, "MISSING_INVOICE_TOTAL");
  const missingPayableTotal = findingFor(reconciliation, "MISSING_PAYABLE_TOTAL");
  const duplicateFinding = findingFor(reconciliation, "DUPLICATE_INVOICE_NUMBER");
  const documentFinding = findingFor(reconciliation, "MISSING_INVOICE_DOCUMENT");
  const subtotalFinding = findingFor(reconciliation, "SUBTOTAL_SERVICE_BASE_MISMATCH");

  const rows: ComparisonRow[] = [];

  rows.push({
    key: "counterparty",
    field: "Counterparty",
    payableValue: `${counterpartyTypeLabel(pin.counterpartyType)} · ${pin.counterpartyRef}`,
    invoiceValue: `${counterpartyTypeLabel(pin.counterpartyType)} · ${pin.counterpartyRef}`,
    result: counterpartyFinding ? RESULT_CHIPS.MISMATCH : RESULT_CHIPS.MATCH,
    resolution: counterpartyFinding?.message ?? "Not required.",
  });

  rows.push({
    key: "currency",
    field: "Currency",
    payableValue: pin.payableCurrency,
    invoiceValue: declared.currency ?? "Not set",
    result: currencyFinding ? RESULT_CHIPS.MISMATCH : declared.currency === null ? RESULT_CHIPS.MISSING_IN_INVOICE : RESULT_CHIPS.MATCH,
    resolution: currencyFinding?.message ?? (declared.currency === null ? "Enter the invoice currency." : "Not required."),
  });

  rows.push({
    key: "commercialPeriod",
    field: "Commercial period",
    payableValue: commercialPeriodLabel(pin.commercialPeriod.periodKey),
    invoiceValue: commercialPeriodLabel(pin.commercialPeriod.periodKey),
    result: periodFinding ? RESULT_CHIPS.MISMATCH : RESULT_CHIPS.MATCH,
    resolution: periodFinding?.message ?? "Not required.",
  });

  // Step 15C section 18/23: the Invoice's declared total reconciles against the Payable's GROSS
  // EXPECTED INVOICE TOTAL (service base + GST) - never the after-TDS expected net payment.
  const payableGrossText = formatSignedMoneyMinor(pin.payableGrossInvoiceExpectedMinor, pin.payableCurrency, { amountsVisible });
  const invoiceTotalText = formatMoneyMinor(declared.declaredTotalMinor, declared.currency, { amountsVisible });
  const totalResult: ComparisonResult = missingInvoiceTotal ? "MISSING_IN_INVOICE" : missingPayableTotal ? "MISSING_IN_PAYABLE" : totalFinding ? "MISMATCH" : "MATCH";
  rows.push({
    key: "total",
    field: "Gross expected Invoice / declared total",
    payableValue: payableGrossText,
    invoiceValue: invoiceTotalText,
    result: RESULT_CHIPS[totalResult],
    resolution: totalFinding?.message ?? missingInvoiceTotal?.message ?? missingPayableTotal?.message ?? "Not required.",
  });

  // Informational (never blocking on its own): the supplier's own subtotal against the Payable's
  // prorated service base.
  const declaredSubtotal = declared.subtotalMinor ?? null;
  const serviceBaseResult: ComparisonResult = subtotalFinding ? "REVIEW_REQUIRED" : declaredSubtotal === null ? "MISSING_IN_INVOICE" : "MATCH";
  rows.push({
    key: "serviceBase",
    field: "Service base / declared subtotal",
    payableValue: formatSignedMoneyMinor(pin.payableServiceBaseMinor, pin.payableCurrency, { amountsVisible }),
    invoiceValue: formatMoneyMinor(declaredSubtotal, declared.currency, { amountsVisible }),
    result: RESULT_CHIPS[serviceBaseResult],
    resolution: subtotalFinding?.message ?? (declaredSubtotal === null ? "Enter the invoice subtotal." : "Not required."),
  });

  // GST: informational comparison against the Payable's own expected GST (no dedicated blocker
  // code exists for GST alone - a GST difference surfaces through the gross-total mismatch above).
  const declaredTax = declared.taxTotalMinor ?? null;
  rows.push({
    key: "gst",
    field: "GST (expected / declared tax lines)",
    payableValue: formatSignedMoneyMinor(pin.payableGstMinor, pin.payableCurrency, { amountsVisible }),
    invoiceValue: formatMoneyMinor(declaredTax, declared.currency, { amountsVisible }),
    result: declaredTax !== null && pin.payableGstMinor !== null && declaredTax !== pin.payableGstMinor ? RESULT_CHIPS.REVIEW_REQUIRED : RESULT_CHIPS.MATCH,
    resolution: "Informational - the gross total above is the binding reconciliation target.",
  });

  // TDS: NEVER an Invoice-total line - shown as its own informational payment-treatment row,
  // always separate from anything the supplier's Invoice states (section 20/25).
  rows.push({
    key: "tds",
    field: "TDS (platform payment treatment)",
    payableValue: formatSignedMoneyMinor(pin.payableTdsMinor, pin.payableCurrency, { amountsVisible }),
    invoiceValue: "Not an Invoice line",
    result: RESULT_CHIPS.MATCH,
    resolution: "TDS is withheld at payment, separate from the supplier's declared Invoice total.",
  });

  rows.push({
    key: "expectedNetPayment",
    field: "Expected net payment",
    payableValue: formatSignedMoneyMinor(pin.payableExpectedNetPaymentMinor, pin.payableCurrency, { amountsVisible }),
    invoiceValue: "—",
    result: RESULT_CHIPS.MATCH,
    resolution: "Informational only - what CreatorOps will pay out after TDS, not a reconciliation target.",
  });

  const numberResult: ComparisonResult = duplicateFinding ? "MISMATCH" : declared.externalInvoiceNumber === null ? "REVIEW_REQUIRED" : "MATCH";
  rows.push({
    key: "invoiceNumber",
    field: "Invoice number uniqueness",
    payableValue: "—",
    invoiceValue: declared.externalInvoiceNumber ?? "Not set",
    result: RESULT_CHIPS[numberResult],
    resolution: duplicateFinding?.message ?? (declared.externalInvoiceNumber === null ? "Enter the supplier invoice number." : "Not required."),
  });

  rows.push({
    key: "document",
    field: "Required document",
    payableValue: "—",
    invoiceValue: documentPresent ? "Attached" : "Not attached",
    result: documentFinding ? RESULT_CHIPS.MISSING_IN_INVOICE : RESULT_CHIPS.MATCH,
    resolution: documentFinding?.message ?? "Not required.",
  });

  rows.push({
    key: "payableVersion",
    field: "Source Payable version",
    payableValue: `v${pin.payableVersion}`,
    invoiceValue: `v${pin.payableVersion} (pinned)`,
    result: RESULT_CHIPS.MATCH,
    resolution: "Pinned at creation. See the source-revision notice if a newer Payable version now exists.",
  });

  return rows;
}

// --- Payee identity (Step 16C section 14/16) -----------------------------------------------------------------------------------------
// Compact section rows: Name / GST / Address / Bank / Overall. Every value here is already safe
// (server-provided display strings, restricted values pre-masked) - this is pure display mapping,
// never a re-derivation of the server's verdict.
export type PayeeIdentityRow = { key: string; field: string; expected: string; extracted: string; result: ChipSpec; reason: string | null };

export function payeeIdentityRows(payeeIdentity: InvoicePayeeIdentityDto): PayeeIdentityRow[] {
  return payeeIdentity.fields.map((field) => ({
    key: field.field,
    field: payeeIdentityFieldLabel(field.field),
    expected: field.safeExpectedDisplay ?? "Not available",
    extracted: field.safeExtractedDisplay ?? "Not available",
    result: payeeIdentityFieldChip(field.status),
    reason: field.reason,
  }));
}

export type PayeeIdentityOverallRow = { result: ChipSpec; accepted: InvoicePayeeIdentityDto["accepted"] };

export function payeeIdentityOverallRow(payeeIdentity: InvoicePayeeIdentityDto): PayeeIdentityOverallRow {
  return { result: payeeIdentityOverallChip(payeeIdentity.overallStatus), accepted: payeeIdentity.accepted };
}

// Section 11: the user must make an explicit decision when MISMATCH or REVIEW_REQUIRED and no
// resolution has been recorded yet for this exact version.
export function payeeIdentityNeedsResolution(payeeIdentity: InvoicePayeeIdentityDto): boolean {
  return (payeeIdentity.overallStatus === "MISMATCH" || payeeIdentity.overallStatus === "REVIEW_REQUIRED") && payeeIdentity.accepted === null;
}

export function arithmeticWarning(reconciliation: InvoiceReconciliationResult): string | null {
  return findingFor(reconciliation, "ARITHMETIC_INCONSISTENT")?.message ?? null;
}

export function hasMismatchFinding(reconciliation: InvoiceReconciliationResult): boolean {
  return findingFor(reconciliation, "TOTAL_AMOUNT_MISMATCH") !== null;
}

export function unresolvedBlockerCount(reconciliation: InvoiceReconciliationResult, mismatchAcceptedForThisVersion: boolean): number {
  return reconciliation.findings.filter((finding) => {
    if (finding.severity !== "BLOCKER") return false;
    if (finding.code === "TOTAL_AMOUNT_MISMATCH" && mismatchAcceptedForThisVersion) return false;
    return true;
  }).length;
}

// --- Readiness panel (Stage 3 / Detail Approval-readiness) ---------------------------------------------------------------------------
export type ReadinessRow = { label: string; state: "ready" | "needs_review" | "blocked" };

export function reconciliationReadinessRows(input: {
  declared: ReconciliationDeclared;
  documentPresent: boolean;
  reconciliation: InvoiceReconciliationResult;
  mismatchAcceptedForThisVersion: boolean;
}): ReadinessRow[] {
  const { declared, documentPresent, reconciliation, mismatchAcceptedForThisVersion } = input;
  const duplicate = findingFor(reconciliation, "DUPLICATE_INVOICE_NUMBER") !== null;
  const mismatch = findingFor(reconciliation, "TOTAL_AMOUNT_MISMATCH") !== null;
  const otherBlockers = reconciliation.findings.some((finding) => finding.severity === "BLOCKER" && finding.code !== "TOTAL_AMOUNT_MISMATCH" && !(finding.code === "DUPLICATE_INVOICE_NUMBER"));

  return [
    { label: "Eligible Payable pinned", state: "ready" },
    { label: "Invoice number complete", state: declared.externalInvoiceNumber !== null ? "ready" : "needs_review" },
    { label: "Original document attached", state: documentPresent ? "ready" : "needs_review" },
    { label: "Currency resolved", state: declared.currency !== null ? "ready" : "needs_review" },
    { label: "Amount reconciliation", state: !mismatch ? "ready" : mismatchAcceptedForThisVersion ? "needs_review" : "blocked" },
    { label: "Duplicate check", state: duplicate ? "blocked" : "ready" },
    { label: "Mismatch resolution", state: !mismatch ? "ready" : mismatchAcceptedForThisVersion ? "ready" : "blocked" },
    { label: "Other reconciliation blockers", state: otherBlockers ? "blocked" : "ready" },
  ];
}
