// Step 17B: the PURE view/adapter logic behind the Payment detail page. Nothing here calls the
// network or touches the DOM.
import type { InvoicePaymentSettlementDto, PaymentDetailDto, PaymentEventDto, PaymentPermissionsDto } from "@/server/finance-payments/client-dto";

import { changeKindLabel, counterpartyTypeLabel, eventKindLabel, formatMoneyMinor, invoicePinRefLabel, payablePinRefLabel, paymentMethodLabel, paymentStatusChip, payeeIdentityStatusLabel, relativeTime, settlementStateChip, type ChipSpec } from "../format";

export type DetailTabKey = "summary" | "settlement" | "source" | "history";
export const DETAIL_TABS: Array<{ key: DetailTabKey; label: string }> = [
  { key: "summary", label: "Summary" },
  { key: "settlement", label: "Settlement" },
  { key: "source", label: "Source Invoice" },
  { key: "history", label: "History" },
];

export function parseDetailTab(raw: string | string[] | undefined): DetailTabKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return DETAIL_TABS.some((tab) => tab.key === value) ? (value as DetailTabKey) : "summary";
}

// --- Source revision (section 18/14) --------------------------------------------------------------------------------------------------
// Compares the Payment's PINNED Invoice version against the Invoice's CURRENT latest version.
// Never writes, never recalculates, never re-pins - mirrors the backend's own
// comparePaymentInvoiceRevision (payment-source.ts), computed client-side here because Step 17A
// exposes no dedicated GET /source-revision route for Payments (unlike Invoices'/Payables' own) -
// the current Invoice head is already read through Invoices' own published detail endpoint
// (getInvoiceForPayment in api-client.ts) for other reasons on this page, so this reuses that same
// read rather than adding a new backend route for a client-computable comparison.
export function paymentSourceRevisionState(pinnedInvoiceVersion: number, currentInvoiceLatestVersion: number | null): "CURRENT" | "INVOICE_REVISION_AVAILABLE" {
  if (currentInvoiceLatestVersion === null) return "CURRENT";
  return currentInvoiceLatestVersion > pinnedInvoiceVersion ? "INVOICE_REVISION_AVAILABLE" : "CURRENT";
}

// --- Header -----------------------------------------------------------------------------------------------------------------------
export type DetailHeaderView = { title: string; secondary: string; statusChip: ChipSpec };

export function detailHeaderView(head: PaymentDetailDto["head"]): DetailHeaderView {
  return {
    title: head.paymentRef,
    secondary: `${head.invoiceRef} · ${head.counterparty.displayName ?? head.counterparty.ref}`,
    statusChip: paymentStatusChip(head.status),
  };
}

// Actions depend on both the lifecycle status AND the exact server-computed permission - never a
// role-rank assumption (section 15: exact Step 17A transitions).
export type DetailActionVisibility = {
  canEdit: boolean;
  canRecord: boolean;
  canConfirm: boolean;
  canMarkFailed: boolean;
  canReopen: boolean;
  canVoid: boolean;
  readOnly: boolean;
};

export function detailActionVisibility(head: PaymentDetailDto["head"], permissions: PaymentPermissionsDto): DetailActionVisibility {
  const none: DetailActionVisibility = { canEdit: false, canRecord: false, canConfirm: false, canMarkFailed: false, canReopen: false, canVoid: false, readOnly: true };
  if (head.status === "VOID") return none;
  if (head.status === "DRAFT") return { ...none, canEdit: permissions.canManage, canRecord: permissions.canManage, canVoid: permissions.canVoid, readOnly: false };
  if (head.status === "RECORDED") return { ...none, canConfirm: permissions.canConfirm, canMarkFailed: permissions.canManage, canVoid: permissions.canVoid, readOnly: false };
  if (head.status === "CONFIRMED") return { ...none, canVoid: permissions.canVoid, readOnly: false };
  // FAILED
  return { ...none, canReopen: permissions.canManage, canVoid: permissions.canVoid, readOnly: false };
}

// --- Summary tab ------------------------------------------------------------------------------------------------------------------
export type SummaryRow = { label: string; value: string };

export function summaryRows(detail: PaymentDetailDto): SummaryRow[] {
  const { head, selectedVersion } = detail;
  const opts = { amountsVisible: detail.amountsVisible };
  return [
    { label: "Amount", value: formatMoneyMinor(head.amountMinor, head.currency, opts) },
    { label: "Currency", value: head.currency },
    { label: "Payment date", value: selectedVersion?.paymentDate ?? "Not set" },
    { label: "Method", value: paymentMethodLabel(selectedVersion?.method ?? null) },
    { label: "External reference", value: selectedVersion?.externalReference ?? "Not set" },
    { label: "Status", value: paymentStatusChip(head.status).label },
    { label: "Counterparty", value: `${head.counterparty.displayName ?? head.counterparty.ref} (${counterpartyTypeLabel(head.counterparty.type)})` },
    { label: "Invoice", value: head.invoiceRef },
    { label: "Created", value: relativeTime(head.createdAt) },
    { label: "Updated", value: relativeTime(head.updatedAt) },
    { label: "Note", value: selectedVersion?.memo ?? "—" },
  ];
}

export type StatusPayeePanelView = {
  lifecycle: ChipSpec;
  payeeIdentityStatus: string;
  bankSafeDisplay: string;
  hasSourceRevisionWarning: boolean;
};

// Payments never carry per-field payee identity - only the already-masked snapshot pinned once at
// creation (section 12/20): `bankSafeDisplay` is copied verbatim from that snapshot, never re-derived.
export function statusPayeePanelView(detail: PaymentDetailDto, revisionState: string | null): StatusPayeePanelView {
  const { head, selectedVersion } = detail;
  return {
    lifecycle: paymentStatusChip(head.status),
    payeeIdentityStatus: payeeIdentityStatusLabel(selectedVersion?.payeeIdentity.overallStatusAtApproval ?? null),
    bankSafeDisplay: selectedVersion?.payeeIdentity.bankSafeDisplay ?? "Not available",
    hasSourceRevisionWarning: revisionState !== null && revisionState !== "CURRENT",
  };
}

// --- Settlement tab (section 12) -----------------------------------------------------------------------------------------------------
export type SettlementSummaryRow = { label: string; value: string };

export function settlementSummaryRows(settlement: InvoicePaymentSettlementDto): SettlementSummaryRow[] {
  const opts = { amountsVisible: settlement.amountsVisible };
  const { summary } = settlement;
  return [
    { label: "Expected net payment", value: formatMoneyMinor(summary.expectedNetPaymentMinor, settlement.currency, opts) },
    { label: "Confirmed paid total", value: formatMoneyMinor(summary.confirmedPaidMinor, settlement.currency, opts) },
    { label: "Recorded (pending) total", value: formatMoneyMinor(summary.recordedPendingMinor, settlement.currency, opts) },
    { label: "Failed total", value: formatMoneyMinor(summary.failedMinor, settlement.currency, opts) },
    { label: "Remaining amount", value: formatMoneyMinor(summary.remainingMinor, settlement.currency, opts) },
  ];
}

export function settlementStateView(settlement: InvoicePaymentSettlementDto): ChipSpec {
  return settlementStateChip(settlement.summary.state);
}

export type RelatedPaymentRow = { key: string; paymentRef: string; detailHref: string; date: string; amountText: string; methodText: string; status: ChipSpec; externalReference: string };

export function relatedPaymentRows(settlement: InvoicePaymentSettlementDto): RelatedPaymentRow[] {
  const opts = { amountsVisible: settlement.amountsVisible };
  return settlement.payments.map((row) => ({
    key: row.paymentRef,
    paymentRef: row.paymentRef,
    detailHref: `/finance/payments/${encodeURIComponent(row.paymentRef)}`,
    date: relativeTime(row.lastUpdatedAt),
    amountText: formatMoneyMinor(row.amountMinor, settlement.currency, opts),
    methodText: paymentMethodLabel(row.method),
    status: paymentStatusChip(row.status),
    externalReference: "—",
  }));
}

// --- Source Invoice tab (section 13) ------------------------------------------------------------------------------------------------
export type SourceInvoiceRow = { label: string; value: string };

export function sourceInvoiceRows(detail: PaymentDetailDto): SourceInvoiceRow[] {
  const { head, selectedVersion } = detail;
  const opts = { amountsVisible: detail.amountsVisible };
  const pin = selectedVersion?.invoicePin ?? null;
  const currency = pin?.currency ?? head.currency;
  const rows: SourceInvoiceRow[] = [
    { label: "Invoice number", value: pin?.externalInvoiceNumber ?? "—" },
    { label: "Invoice ref / version", value: pin ? invoicePinRefLabel(pin) : head.invoiceRef },
    { label: "Counterparty", value: `${head.counterparty.displayName ?? head.counterparty.ref} (${counterpartyTypeLabel(head.counterparty.type)})` },
    { label: "Payable ref / version", value: pin ? payablePinRefLabel(pin) : head.payableRef },
    { label: "Commercial period", value: pin?.commercialPeriod.periodKey ?? "—" },
    { label: "Currency", value: currency },
    { label: "Service base", value: formatMoneyMinor(pin?.serviceBaseMinor ?? null, currency, opts) },
    { label: "GST", value: formatMoneyMinor(pin?.gstMinor ?? null, currency, opts) },
    { label: "Gross approved Invoice", value: formatMoneyMinor(pin?.grossInvoiceExpectedMinor ?? null, currency, opts) },
    { label: "TDS", value: formatMoneyMinor(pin?.tdsMinor ?? null, currency, opts) },
    { label: "Expected net payment", value: formatMoneyMinor(pin?.expectedNetPaymentMinor ?? null, currency, opts) },
    { label: "Payee identity decision", value: payeeIdentityStatusLabel(selectedVersion?.payeeIdentity.overallStatusAtApproval ?? null) },
  ];
  return rows;
}

// --- History tab ------------------------------------------------------------------------------------------------------------------
export type HistoryRow = { key: string; date: string; event: string; version: number; actor: string; reasonOrMetadata: string };

export function historyRows(events: PaymentEventDto[]): HistoryRow[] {
  return events.map((event, index) => ({
    key: `${event.kind}-${event.version}-${event.createdAt}-${index}`,
    date: relativeTime(event.createdAt),
    event: eventKindLabel(event.kind),
    version: event.version,
    actor: event.actorUserRef,
    reasonOrMetadata: metadataSummary(event.metadata),
  }));
}

function metadataSummary(metadata: Record<string, unknown> | null): string {
  if (!metadata) return "—";
  const reason = metadata.reason;
  if (typeof reason === "string" && reason.length > 0) return reason;
  const changeKindRaw = metadata.changeKind;
  if (typeof changeKindRaw === "string") {
    const known = ["created", "revised", "reopened"];
    if (known.includes(changeKindRaw)) return changeKindLabel(changeKindRaw as "created" | "revised" | "reopened");
  }
  const method = metadata.method;
  if (typeof method === "string" && method.length > 0) return `Method: ${method}`;
  return "—";
}
