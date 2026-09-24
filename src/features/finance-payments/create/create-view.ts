// Step 17B: the PURE view/adapter logic behind the Record Payment flow (Source Invoice -> Payment
// Details -> Confirm). Nothing here calls the network or touches the DOM - every function maps data
// already in hand to what a screen renders, so it is unit-testable in isolation.
import type { InvoicePaymentSettlementDto, PaymentDetailDto } from "@/server/finance-payments/client-dto";
import type { PaymentCounterpartyType, PaymentMethod, PaymentSettlementState } from "@/server/finance-payments/types";

import { commercialPeriodLabel, counterpartyTypeLabel, counterpartyTypeTone, formatMoneyMinor, invoicePinRefLabel, parseMoneyInputToMinor, payablePinRefLabel, payeeIdentityStatusLabel, paymentMethodLabel, settlementStateChip, type ChipSpec, type PillTone } from "../format";

export type CreateStage = 1 | 2 | 3;
export const CREATE_STAGE_LABELS: Record<CreateStage, string> = { 1: "Source Invoice", 2: "Payment Details", 3: "Confirm" };

export const NEVER_SETTLED_NOTE = "Payments are recorded against the net amount after TDS.";
export const RECORDED_NOT_SETTLED_NOTE = "RECORDED does not reduce confirmed settlement until this Payment is confirmed.";
export const RECORD_TRANSFER_NOTE = "Record the transfer details after the payment has been initiated outside CreatorOps.";
export const DRAFT_LIFECYCLE_WORDING = "This Payment will be created as Draft.";

// --- Stage 1: Source Invoice -------------------------------------------------------------------------------------------------------
// One eligible-Invoice source row - composed by the component from THREE server reads (Invoices'
// own workspace row, its detail payablePin, and this module's own settlement projection); this
// function only maps the already-composed data to what the row renders. Never exposes a raw bank
// value - only the opaque refs, commercial evidence and settlement figures already safe to show.
export type EligibleInvoiceSource = {
  invoiceRef: string;
  invoiceNumber: string | null;
  counterpartyType: PaymentCounterpartyType;
  counterpartyName: string;
  commercialPeriodKey: string;
  currency: string | null;
  grossInvoiceMinor: number | null;
  tdsMinor: number | null;
  expectedNetPaymentMinor: number | null;
  confirmedPaidMinor: number | null;
  remainingMinor: number | null;
  settlementState: PaymentSettlementState | null;
  amountsVisible: boolean;
};

export type EligibleInvoiceRowView = {
  key: string;
  invoiceRef: string;
  invoiceNumber: string;
  counterpartyName: string;
  counterpartyTypeLabel: string;
  counterpartyTypeTone: PillTone;
  commercialPeriod: string;
  grossInvoiceText: string;
  tdsText: string;
  expectedNetPaymentText: string;
  confirmedPaidText: string;
  remainingText: string;
  settlement: ChipSpec | null;
};

export function toEligibleInvoiceRowView(row: EligibleInvoiceSource): EligibleInvoiceRowView {
  const opts = { amountsVisible: row.amountsVisible };
  return {
    key: row.invoiceRef,
    invoiceRef: row.invoiceRef,
    invoiceNumber: row.invoiceNumber ?? "—",
    counterpartyName: row.counterpartyName,
    counterpartyTypeLabel: counterpartyTypeLabel(row.counterpartyType),
    counterpartyTypeTone: counterpartyTypeTone(row.counterpartyType),
    commercialPeriod: commercialPeriodLabel(row.commercialPeriodKey),
    grossInvoiceText: formatMoneyMinor(row.grossInvoiceMinor, row.currency, opts),
    tdsText: formatMoneyMinor(row.tdsMinor, row.currency, opts),
    expectedNetPaymentText: formatMoneyMinor(row.expectedNetPaymentMinor, row.currency, opts),
    confirmedPaidText: formatMoneyMinor(row.confirmedPaidMinor, row.currency, opts),
    remainingText: formatMoneyMinor(row.remainingMinor, row.currency, opts),
    settlement: row.settlementState ? settlementStateChip(row.settlementState) : null,
  };
}

export type SelectedInvoiceSummaryRow = { label: string; value: string };

// The Stage 1 "Selected Invoice summary" panel (section 6). Never exposes a raw bank value - only
// the already-masked `bankSafeDisplay` the Invoice module itself computed.
export function selectedInvoiceSummary(input: {
  counterpartyName: string;
  invoiceNumber: string | null;
  invoiceRef: string;
  invoiceVersion: number;
  payableRef: string;
  payableVersion: number;
  currency: string | null;
  serviceBaseMinor: number | null;
  gstMinor: number | null;
  grossInvoiceMinor: number | null;
  tdsMinor: number | null;
  expectedNetPaymentMinor: number | null;
  confirmedPaidMinor: number | null;
  remainingMinor: number | null;
  payeeIdentityStatus: string | null;
  bankSafeDisplay: string | null;
  settlementState: PaymentSettlementState | null;
  amountsVisible: boolean;
}): SelectedInvoiceSummaryRow[] {
  const opts = { amountsVisible: input.amountsVisible };
  const rows: SelectedInvoiceSummaryRow[] = [
    { label: "Counterparty", value: input.counterpartyName },
    { label: "Invoice number", value: input.invoiceNumber ?? "Not set" },
    { label: "Invoice ref / version", value: invoicePinRefLabel({ invoiceRef: input.invoiceRef, invoiceVersion: input.invoiceVersion }) },
    { label: "Payable ref / version", value: payablePinRefLabel({ payableRef: input.payableRef, payableVersion: input.payableVersion }) },
    { label: "Currency", value: input.currency ?? "Not set" },
    { label: "Service base", value: formatMoneyMinor(input.serviceBaseMinor, input.currency, opts) },
    { label: "GST", value: formatMoneyMinor(input.gstMinor, input.currency, opts) },
    { label: "Gross Invoice", value: formatMoneyMinor(input.grossInvoiceMinor, input.currency, opts) },
    { label: "TDS", value: formatMoneyMinor(input.tdsMinor, input.currency, opts) },
    { label: "Expected net payment", value: formatMoneyMinor(input.expectedNetPaymentMinor, input.currency, opts) },
    { label: "Confirmed paid", value: formatMoneyMinor(input.confirmedPaidMinor, input.currency, opts) },
    { label: "Remaining", value: formatMoneyMinor(input.remainingMinor, input.currency, opts) },
    { label: "Payee identity status", value: payeeIdentityStatusLabel(input.payeeIdentityStatus) },
    { label: "Destination (masked)", value: input.bankSafeDisplay ?? "Not available" },
  ];
  return rows;
}

// --- Stage 2: Payment Details -----------------------------------------------------------------------------------------------------
export type PaymentDetailsForm = {
  amountText: string;
  paymentDate: string;
  method: PaymentMethod | "";
  externalReference: string;
  memo: string;
};

export function emptyPaymentDetailsForm(defaultAmountMinor: number | null, today: string): PaymentDetailsForm {
  return {
    amountText: defaultAmountMinor !== null && defaultAmountMinor > 0 ? String(defaultAmountMinor / 100) : "",
    paymentDate: today,
    method: "",
    externalReference: "",
    memo: "",
  };
}

export function paymentDetailsFormComplete(form: PaymentDetailsForm): boolean {
  return form.amountText.trim().length > 0 && form.paymentDate.trim().length > 0 && form.method !== "";
}

export type ReviseFieldsResult = { ok: true; fields: { amountMinor: number; paymentDate: string; method: PaymentMethod; externalReference: string | null; memo: string | null } } | { ok: false; errors: string[] };

// Converts Stage 2's plain-text form into the typed payload revisePaymentDraft expects. Never
// invents a value; amount parsing failures are collected and returned instead of silently coercing.
export function reviseFieldsFromForm(form: PaymentDetailsForm): ReviseFieldsResult {
  const errors: string[] = [];
  let amountMinor = 0;
  if (form.amountText.trim().length === 0) {
    errors.push("Enter a payment amount.");
  } else {
    const parsed = parseMoneyInputToMinor(form.amountText);
    if (!parsed.ok) errors.push(`Payment amount: ${parsed.message}`);
    else amountMinor = parsed.amountMinor;
  }
  if (form.paymentDate.trim().length === 0) errors.push("Enter a payment date.");
  if (form.method === "") errors.push("Select a payment method.");

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    fields: {
      amountMinor,
      paymentDate: form.paymentDate,
      method: form.method as PaymentMethod,
      externalReference: form.externalReference.trim() || null,
      memo: form.memo.trim() || null,
    },
  };
}

// The partial-payment UX table (section 17): expected net payment / confirmed paid / remaining /
// this Payment / remaining after confirm. `thisPaymentMinor` is null before a valid amount is typed.
export type SettlementImpactRow = { label: string; value: string };

export function settlementImpactRows(input: { expectedNetPaymentMinor: number | null; confirmedPaidMinor: number | null; remainingMinor: number | null; thisPaymentMinor: number | null; currency: string | null; amountsVisible: boolean }): SettlementImpactRow[] {
  const opts = { amountsVisible: input.amountsVisible };
  const remainingAfter = remainingAfterThisPayment(input.remainingMinor, input.thisPaymentMinor);
  return [
    { label: "Expected net payment", value: formatMoneyMinor(input.expectedNetPaymentMinor, input.currency, opts) },
    { label: "Confirmed paid", value: formatMoneyMinor(input.confirmedPaidMinor, input.currency, opts) },
    { label: "Remaining", value: formatMoneyMinor(input.remainingMinor, input.currency, opts) },
    { label: "This Payment", value: input.thisPaymentMinor !== null ? formatMoneyMinor(input.thisPaymentMinor, input.currency, opts) : "—" },
    { label: "Remaining after confirmation", value: remainingAfter !== null ? formatMoneyMinor(remainingAfter, input.currency, opts) : "—" },
  ];
}

// PURE: never negative (clamped to 0, mirroring the backend settlement calculator's own clamp) - a
// caller reads a separate overpayment warning, never a negative "remaining".
export function remainingAfterThisPayment(remainingMinor: number | null, thisPaymentMinor: number | null): number | null {
  if (remainingMinor === null || thisPaymentMinor === null) return remainingMinor;
  return Math.max(0, remainingMinor - thisPaymentMinor);
}

// Section 8/17: "do not silently cap overpayment - show a blocking warning" if the amount typed
// exceeds the currently known remaining amount. This is advisory at DRAFT stage (the backend only
// enforces the block transactionally at CONFIRM, per settlement-calculator.ts) - never a hard client
// cap, and never invented when remaining is not yet known.
export function overpaymentWarning(remainingMinor: number | null, thisPaymentMinor: number | null): string | null {
  if (remainingMinor === null || thisPaymentMinor === null) return null;
  if (thisPaymentMinor <= remainingMinor) return null;
  const excess = thisPaymentMinor - remainingMinor;
  return `This amount exceeds the remaining balance by ${excess} minor units. Confirming this Payment will be blocked unless an authorized overpayment override is used.`;
}

// --- Stage 3: Confirm ----------------------------------------------------------------------------------------------------------------
export type ConfirmSummaryRow = { label: string; value: string };

export function paymentSummaryRows(detail: PaymentDetailDto): ConfirmSummaryRow[] {
  const { head, selectedVersion } = detail;
  const opts = { amountsVisible: detail.amountsVisible };
  const rows: ConfirmSummaryRow[] = [
    { label: "Counterparty", value: head.counterparty.displayName ?? head.counterparty.ref },
    { label: "Invoice", value: head.invoiceRef },
    { label: "Payment amount", value: formatMoneyMinor(head.amountMinor, head.currency, opts) },
    { label: "Payment date", value: selectedVersion?.paymentDate ?? "Not set" },
    { label: "Method", value: paymentMethodLabel(selectedVersion?.method ?? null) },
    { label: "External reference", value: selectedVersion?.externalReference ?? "Not set" },
    { label: "Currency", value: head.currency },
  ];
  if (selectedVersion?.memo) rows.push({ label: "Note", value: selectedVersion.memo });
  return rows;
}

export function confirmSettlementImpactRows(detail: PaymentDetailDto, settlementBefore: InvoicePaymentSettlementDto | null): SettlementImpactRow[] {
  const opts = { amountsVisible: detail.amountsVisible };
  const currency = detail.head.currency;
  const expected = settlementBefore?.summary.expectedNetPaymentMinor ?? detail.selectedVersion?.invoicePin.expectedNetPaymentMinor ?? null;
  const confirmedBefore = settlementBefore?.summary.confirmedPaidMinor ?? null;
  const remainingBefore = settlementBefore?.summary.remainingMinor ?? null;
  const thisPayment = detail.head.amountMinor;
  const remainingAfter = remainingAfterThisPayment(remainingBefore, thisPayment);
  return [
    { label: "Expected net payment", value: formatMoneyMinor(expected, currency, opts) },
    { label: "Confirmed paid before", value: formatMoneyMinor(confirmedBefore, currency, opts) },
    { label: "This Payment", value: formatMoneyMinor(thisPayment, currency, opts) },
    { label: "Remaining if/when confirmed", value: remainingAfter !== null ? formatMoneyMinor(remainingAfter, currency, opts) : "—" },
  ];
}
