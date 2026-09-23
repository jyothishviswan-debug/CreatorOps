// Step 16B: the PURE view/adapter logic behind the Reconciliation comparison table and readiness
// panel. Shared between the Create wizard's Stage 3 and the Invoice detail's Reconciliation tab, so
// the two screens can never disagree about what a given reconciliation result means. Nothing here
// calls the network, invents an amount, or recomputes what the server already decided (section 11:
// human labels only, never a raw enum/camelCase code).
import type { InvoicePayablePinDto } from "@/server/finance-invoices/client-dto";
import type { InvoiceReconciliationResult } from "@/server/finance-invoices/types";

import { commercialPeriodLabel, counterpartyTypeLabel, formatMoneyMinor, formatSignedMoneyMinor, type ChipSpec } from "./format";

export type ReconciliationDeclared = {
  currency: string | null;
  declaredTotalMinor: number | null;
  externalInvoiceNumber: string | null;
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

  const payableTotalText = formatSignedMoneyMinor(pin.payableExpectedTotalMinorSigned, pin.payableCurrency, { amountsVisible });
  const invoiceTotalText = formatMoneyMinor(declared.declaredTotalMinor, declared.currency, { amountsVisible });
  const totalResult: ComparisonResult = missingInvoiceTotal ? "MISSING_IN_INVOICE" : missingPayableTotal ? "MISSING_IN_PAYABLE" : totalFinding ? "MISMATCH" : "MATCH";
  rows.push({
    key: "total",
    field: "Expected / declared total",
    payableValue: payableTotalText,
    invoiceValue: invoiceTotalText,
    result: RESULT_CHIPS[totalResult],
    resolution: totalFinding?.message ?? missingInvoiceTotal?.message ?? missingPayableTotal?.message ?? "Not required.",
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
