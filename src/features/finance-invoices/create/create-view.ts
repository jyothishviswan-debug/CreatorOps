// Step 16B: the PURE view/adapter logic behind the Create Invoice flow (Source Payable -> Invoice
// Details -> Reconciliation -> Confirm). Nothing here calls the network or touches the DOM - every
// function maps a DTO already in hand to what a screen renders, so it is unit-testable in isolation
// and the four stages, the tests and each other can never disagree about what a given server
// response means.
import type { PayableRowDto } from "@/server/finance-payables/client-dto";
import type { InvoiceDetailDto, InvoiceTaxLineDto } from "@/server/finance-invoices/client-dto";
import type { PreviewInvoiceEligibilityDto } from "@/server/finance-invoices/invoice-service";

import { commercialPeriodLabel, counterpartyTypeLabel, counterpartyTypeTone, formatMoneyMinor, formatSignedMoneyMinor, parseMoneyInputToMinor, parseRatePercentToBasisPoints, type PillTone } from "../format";

// Re-exported so Stage 1's component (a .tsx file) never names `@/server/finance-payables` itself -
// Invoices' OWN server module already reads Payables through its published, read-only contract
// (payable-source.ts); this keeps that same "read through the published contract" discipline on
// the client side too, and keeps every file that imports the Payables backend directly confined to
// Payables' own UI tree (see finance-payables-static.test.ts's containment guard).
export type EligiblePayableSourceRow = PayableRowDto;

export type CreateStage = 1 | 2 | 3 | 4;
export const CREATE_STAGE_LABELS: Record<CreateStage, string> = { 1: "Source Payable", 2: "Invoice Details", 3: "Reconciliation", 4: "Confirm" };

// --- Stage 1: Source Payable -------------------------------------------------------------------------------------------------------
export type EligiblePayableRowView = {
  key: string;
  payableRef: string;
  counterpartyName: string;
  counterpartyTypeLabel: string;
  counterpartyTypeTone: PillTone;
  commercialPeriod: string;
  currency: string;
  totalText: string;
  agreementText: string;
};

export function toEligiblePayableRowView(row: PayableRowDto, amountsVisible: boolean): EligiblePayableRowView {
  return {
    key: row.payableRef,
    payableRef: row.payableRef,
    counterpartyName: row.counterparty.displayName?.trim() || "Unnamed counterparty",
    counterpartyTypeLabel: counterpartyTypeLabel(row.counterparty.type),
    counterpartyTypeTone: counterpartyTypeTone(row.counterparty.type),
    commercialPeriod: commercialPeriodLabel(row.commercialPeriod),
    currency: row.currency,
    totalText: formatSignedMoneyMinor(row.totalAmountMinorSigned, row.currency, { amountsVisible }),
    agreementText: "Agreement-governed",
  };
}

export type SourceReadiness = { canContinue: boolean; blocked: boolean; blockerMessages: string[] };

export function sourceReadiness(preview: PreviewInvoiceEligibilityDto | null): SourceReadiness {
  if (preview === null) return { canContinue: false, blocked: false, blockerMessages: [] };
  return { canContinue: preview.eligible, blocked: !preview.eligible, blockerMessages: preview.blockers.map((blocker) => blocker.message) };
}

export type SelectedPayableSummaryRow = { label: string; value: string };

// The compact "selected Payable" summary shown on the right of Stage 1 once a Payable resolves.
// Never exposes KYC/bank data - only the opaque refs and commercial evidence the pin itself carries.
export function selectedPayableSummary(preview: PreviewInvoiceEligibilityDto): SelectedPayableSummaryRow[] {
  const rows: SelectedPayableSummaryRow[] = [];
  rows.push({ label: "Counterparty", value: preview.counterpartyDisplayName ?? preview.pin?.counterpartyRef ?? "—" });
  if (!preview.pin) return rows;
  rows.push({ label: "Commercial period", value: commercialPeriodLabel(preview.pin.commercialPeriod.periodKey) });
  rows.push({ label: "Payable ref / version", value: `${preview.pin.payableRef} · v${preview.pin.payableVersion}` });
  rows.push({ label: "Agreement ref / version", value: `${preview.pin.agreementRef} · v${preview.pin.agreementVersion}` });
  if (preview.pin.reviewRef !== null) rows.push({ label: "Partner Review ref / version", value: `${preview.pin.reviewRef} · v${preview.pin.reviewVersion}` });
  rows.push({ label: "Currency", value: preview.pin.payableCurrency });
  rows.push({ label: "Service base", value: formatSignedMoneyMinor(preview.pin.payableServiceBaseMinor, preview.pin.payableCurrency, { amountsVisible: preview.amountsVisible }) });
  rows.push({ label: "GST", value: formatSignedMoneyMinor(preview.pin.payableGstMinor, preview.pin.payableCurrency, { amountsVisible: preview.amountsVisible }) });
  rows.push({ label: "Gross expected Invoice total", value: formatSignedMoneyMinor(preview.pin.payableGrossInvoiceExpectedMinor, preview.pin.payableCurrency, { amountsVisible: preview.amountsVisible }) });
  rows.push({ label: "TDS", value: formatSignedMoneyMinor(preview.pin.payableTdsMinor, preview.pin.payableCurrency, { amountsVisible: preview.amountsVisible }) });
  rows.push({ label: "Expected net payment", value: formatSignedMoneyMinor(preview.pin.payableExpectedNetPaymentMinor, preview.pin.payableCurrency, { amountsVisible: preview.amountsVisible }) });
  rows.push({ label: "Determination state", value: preview.eligible ? "Ready for invoice" : "Blocked" });
  rows.push({ label: "Source revision state", value: "Current" });
  return rows;
}

// --- Stage 2: Invoice Details -----------------------------------------------------------------------------------------------------
export type TaxLineDraft = { key: string; label: string; rateText: string; amountText: string };

export function emptyTaxLine(key: string): TaxLineDraft {
  return { key, label: "", rateText: "", amountText: "" };
}

export type InvoiceDetailsForm = {
  externalInvoiceNumber: string;
  invoiceDate: string;
  receivedDate: string;
  currency: string;
  subtotalText: string;
  taxLines: TaxLineDraft[];
  declaredTotalText: string;
  dueDate: string;
};

export function emptyInvoiceDetailsForm(currency: string): InvoiceDetailsForm {
  return { externalInvoiceNumber: "", invoiceDate: "", receivedDate: "", currency, subtotalText: "", taxLines: [], declaredTotalText: "", dueDate: "" };
}

export function invoiceDetailsFormFromVersion(version: { externalInvoiceNumber: string | null; invoiceDate: string | null; receivedDate: string | null; currency: string | null; subtotalMinor: number | null; taxLines: InvoiceTaxLineDto[]; declaredTotalMinor: number | null; dueDate: string | null }, fallbackCurrency: string): InvoiceDetailsForm {
  return {
    externalInvoiceNumber: version.externalInvoiceNumber ?? "",
    invoiceDate: version.invoiceDate ?? "",
    receivedDate: version.receivedDate ?? "",
    currency: version.currency ?? fallbackCurrency,
    subtotalText: version.subtotalMinor !== null ? String(version.subtotalMinor / 100) : "",
    taxLines: version.taxLines.map((line, index) => ({ key: `existing-${index}`, label: line.label, rateText: line.ratePercentBasisPoints !== null ? String(line.ratePercentBasisPoints / 100) : "", amountText: line.amountMinor !== null ? String(line.amountMinor / 100) : "" })),
    declaredTotalText: version.declaredTotalMinor !== null ? String(version.declaredTotalMinor / 100) : "",
    dueDate: version.dueDate ?? "",
  };
}

export function detailsFormComplete(form: InvoiceDetailsForm): boolean {
  return form.externalInvoiceNumber.trim().length > 0 && form.invoiceDate.trim().length > 0 && form.currency.trim().length === 3 && form.declaredTotalText.trim().length > 0;
}

// --- Original document panel --------------------------------------------------------------------------------------------------------
export type DocumentCardView = { fileName: string; mimeLabel: string; sizeText: string; uploaded: boolean };

// Converts the Stage 2 form's plain-text fields into the typed payload `reviseInvoiceDraft` expects.
// Never invents a value: a blank field becomes an explicit `null` (cleared), never a computed
// default. Amount/rate parsing failures are collected and returned instead of silently coercing.
export type ReviseFieldsResult =
  | {
      ok: true;
      fields: {
        externalInvoiceNumber: string | null;
        invoiceDate: string | null;
        receivedDate: string | null;
        currency: string | null;
        subtotalMinor: number | null;
        taxLines: Array<{ label: string; ratePercentBasisPoints: number | null; amountMinor: number }>;
        declaredTotalMinor: number | null;
        dueDate: string | null;
      };
    }
  | { ok: false; errors: string[] };

export function reviseFieldsFromForm(form: InvoiceDetailsForm): ReviseFieldsResult {
  const errors: string[] = [];

  let subtotalMinor: number | null = null;
  if (form.subtotalText.trim().length > 0) {
    const parsed = parseMoneyInputToMinor(form.subtotalText);
    if (!parsed.ok) errors.push(`Declared subtotal: ${parsed.message}`);
    else subtotalMinor = parsed.amountMinor;
  }

  let declaredTotalMinor: number | null = null;
  if (form.declaredTotalText.trim().length > 0) {
    const parsed = parseMoneyInputToMinor(form.declaredTotalText);
    if (!parsed.ok) errors.push(`Declared total: ${parsed.message}`);
    else declaredTotalMinor = parsed.amountMinor;
  }

  const taxLines: Array<{ label: string; ratePercentBasisPoints: number | null; amountMinor: number }> = [];
  for (const line of form.taxLines) {
    if (line.label.trim().length === 0 && line.amountText.trim().length === 0) continue;
    if (line.label.trim().length === 0) {
      errors.push("Every tax line needs a label.");
      continue;
    }
    const amount = parseMoneyInputToMinor(line.amountText || "0");
    if (!amount.ok) {
      errors.push(`${line.label}: ${amount.message}`);
      continue;
    }
    const rate = parseRatePercentToBasisPoints(line.rateText);
    if (!rate.ok) {
      errors.push(`${line.label}: ${rate.message}`);
      continue;
    }
    taxLines.push({ label: line.label.trim(), ratePercentBasisPoints: rate.value, amountMinor: amount.amountMinor });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    fields: {
      externalInvoiceNumber: form.externalInvoiceNumber.trim() || null,
      invoiceDate: form.invoiceDate || null,
      receivedDate: form.receivedDate || null,
      currency: form.currency.trim() ? form.currency.trim().toUpperCase() : null,
      subtotalMinor,
      taxLines,
      declaredTotalMinor,
      dueDate: form.dueDate || null,
    },
  };
}

// --- Stage 3: Reconciliation - see ../reconciliation-view.ts for the comparison table / readiness rows -------------------------------

// --- Stage 4: Confirm ----------------------------------------------------------------------------------------------------------------
export type ConfirmSummaryRow = { label: string; value: string };

export function invoiceSummaryRows(detail: InvoiceDetailDto): ConfirmSummaryRow[] {
  const { head, selectedVersion } = detail;
  const rows: ConfirmSummaryRow[] = [
    { label: "Counterparty", value: head.counterparty.displayName ?? head.counterparty.ref },
    { label: "Invoice number", value: head.externalInvoiceNumber ?? "Not set" },
    { label: "Invoice date", value: selectedVersion?.invoiceDate ?? "Not set" },
    { label: "Currency", value: head.currency ?? "Not set" },
    { label: "Declared subtotal", value: formatMoneyMinor(selectedVersion?.subtotalMinor ?? null, head.currency, { amountsVisible: detail.amountsVisible }) },
    { label: "Declared tax", value: formatMoneyMinor(taxLinesTotal(selectedVersion?.taxLines ?? []), head.currency, { amountsVisible: detail.amountsVisible }) },
    { label: "Declared total", value: formatMoneyMinor(head.declaredTotalMinor, head.currency, { amountsVisible: detail.amountsVisible }) },
    { label: "Commercial period", value: commercialPeriodLabel(head.commercialPeriod.periodKey) },
    { label: "Payable ref / version", value: selectedVersion ? `${selectedVersion.payablePin.payableRef} · v${selectedVersion.payablePin.payableVersion}` : head.payableRef },
  ];
  if (selectedVersion?.dueDate) rows.push({ label: "Due date", value: selectedVersion.dueDate });
  return rows;
}

function taxLinesTotal(lines: InvoiceTaxLineDto[]): number | null {
  if (lines.length === 0) return 0;
  if (lines.some((line) => line.amountMinor === null)) return null;
  return lines.reduce((sum, line) => sum + (line.amountMinor ?? 0), 0);
}

export const DRAFT_LIFECYCLE_WORDING = "The Invoice will be created as Draft.";

export type ConfirmReadinessItem = { label: string; met: boolean };

export function confirmReadiness(detail: InvoiceDetailDto): ConfirmReadinessItem[] {
  const version = detail.selectedVersion;
  return [
    { label: "Source Payable pinned", met: true },
    { label: "Invoice number set", met: (version?.externalInvoiceNumber ?? null) !== null },
    { label: "Document attached", met: (version?.document ?? null) !== null },
    { label: "No unresolved blocking mismatch", met: version ? !version.reconciliation.findings.some((finding) => finding.severity === "BLOCKER") : false },
  ];
}

export type ConfirmBlocker = { code: string; message: string };

export function confirmBlockers(detail: InvoiceDetailDto): ConfirmBlocker[] {
  const version = detail.selectedVersion;
  if (!version) return [];
  return version.reconciliation.findings.filter((finding) => finding.severity === "BLOCKER").map((finding) => ({ code: finding.code, message: finding.message }));
}
