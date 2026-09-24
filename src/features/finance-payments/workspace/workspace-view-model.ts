// Step 17B: the PURE row -> view-model mapping of the Payments workspace. Everything a row renders
// is decided here (labels, chip specs, hrefs), so the table, the card view and the tests all read
// one source. It only ever reads fields of the allowlisted PaymentRowDto: no restricted value,
// storage locator or scope internal can appear here.
import type { PaymentRowDto } from "@/server/finance-payments/client-dto";

import { counterpartyTypeLabel, counterpartyTypeTone, formatMoneyMinor, paymentMethodLabel, paymentStatusChip, relativeTime, type ChipSpec, type PillTone } from "../format";

export const PAYMENTS_BASE_HREF = "/finance/payments";
export const NEW_PAYMENT_HREF = `${PAYMENTS_BASE_HREF}/new`;

export function paymentDetailHref(paymentRef: string): string {
  return `${PAYMENTS_BASE_HREF}/${encodeURIComponent(paymentRef)}`;
}

export function invoiceHref(invoiceRef: string): string {
  return `/finance/invoices/${encodeURIComponent(invoiceRef)}`;
}

export type WorkspaceRowView = {
  key: string;
  paymentRef: string;
  detailHref: string;
  counterpartyName: string;
  counterpartyType: string;
  counterpartyTypeLabel: string;
  counterpartyTypeTone: PillTone;
  invoiceRef: string;
  invoiceHref: string;
  amountText: string;
  methodText: string;
  status: ChipSpec;
  updated: string;
  updatedIso: string;
};

export function initialsOfName(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "");
  const text = letters.join("").toUpperCase();
  return text || "?";
}

export function toWorkspaceRowView(row: PaymentRowDto, amountsVisible: boolean): WorkspaceRowView {
  const name = row.counterparty.displayName?.trim() || "Unnamed counterparty";
  return {
    key: row.paymentRef,
    paymentRef: row.paymentRef,
    detailHref: paymentDetailHref(row.paymentRef),
    counterpartyName: name,
    counterpartyType: row.counterparty.type,
    counterpartyTypeLabel: counterpartyTypeLabel(row.counterparty.type),
    counterpartyTypeTone: counterpartyTypeTone(row.counterparty.type),
    invoiceRef: row.invoiceRef,
    invoiceHref: invoiceHref(row.invoiceRef),
    amountText: formatMoneyMinor(row.amountMinor, row.currency, { amountsVisible }),
    methodText: paymentMethodLabel(row.method),
    status: paymentStatusChip(row.status),
    updated: relativeTime(row.lastUpdatedAt),
    updatedIso: row.lastUpdatedAt,
  };
}

// The compact status-strip counts (Draft / Recorded / Confirmed / Failed / Void), computed from
// the rows already on the page - never a separate unbounded fetch.
export type WorkspaceSummaryCounts = { draft: number; recorded: number; confirmed: number; failed: number; void: number };

export function summarizeWorkspaceRows(rows: PaymentRowDto[]): WorkspaceSummaryCounts {
  const counts: WorkspaceSummaryCounts = { draft: 0, recorded: 0, confirmed: 0, failed: 0, void: 0 };
  for (const row of rows) {
    if (row.status === "DRAFT") counts.draft += 1;
    if (row.status === "RECORDED") counts.recorded += 1;
    if (row.status === "CONFIRMED") counts.confirmed += 1;
    if (row.status === "FAILED") counts.failed += 1;
    if (row.status === "VOID") counts.void += 1;
  }
  return counts;
}
