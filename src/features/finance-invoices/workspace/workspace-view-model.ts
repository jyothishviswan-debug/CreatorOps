// Step 16B: the PURE row -> view-model mapping of the Invoices workspace. Everything a row renders
// is decided here (labels, chip specs, hrefs), so the table, the card view and the tests all read
// one source. It only ever reads fields of the allowlisted InvoiceRowDto: no restricted value,
// storage locator or scope internal can appear here.
import type { InvoiceRowDto } from "@/server/finance-invoices/client-dto";

import { commercialPeriodLabel, counterpartyTypeLabel, counterpartyTypeTone, formatMoneyMinor, invoiceStatusChip, reconciliationChip, relativeTime, type ChipSpec, type PillTone } from "../format";

export const INVOICES_BASE_HREF = "/finance/invoices";
export const NEW_INVOICE_HREF = `${INVOICES_BASE_HREF}/new`;

export function invoiceDetailHref(invoiceRef: string): string {
  return `${INVOICES_BASE_HREF}/${encodeURIComponent(invoiceRef)}`;
}

export type WorkspaceRowView = {
  key: string;
  invoiceRef: string;
  detailHref: string;
  counterpartyName: string;
  counterpartyType: string;
  counterpartyTypeLabel: string;
  counterpartyTypeTone: PillTone;
  invoiceNumber: string;
  commercialPeriod: string;
  payableRef: string;
  payableHref: string;
  amountText: string;
  reconciliation: ChipSpec;
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

export function toWorkspaceRowView(row: InvoiceRowDto, amountsVisible: boolean): WorkspaceRowView {
  const name = row.counterparty.displayName?.trim() || "Unnamed counterparty";
  return {
    key: row.invoiceRef,
    invoiceRef: row.invoiceRef,
    detailHref: invoiceDetailHref(row.invoiceRef),
    counterpartyName: name,
    counterpartyType: row.counterparty.type,
    counterpartyTypeLabel: counterpartyTypeLabel(row.counterparty.type),
    counterpartyTypeTone: counterpartyTypeTone(row.counterparty.type),
    invoiceNumber: row.externalInvoiceNumber ?? "—",
    commercialPeriod: commercialPeriodLabel(row.commercialPeriod),
    payableRef: row.payableRef,
    payableHref: `/finance/payables/${encodeURIComponent(row.payableRef)}`,
    amountText: formatMoneyMinor(row.declaredTotalMinor, row.currency, { amountsVisible }),
    reconciliation: reconciliationChip(row.reconciliationState),
    status: invoiceStatusChip(row.status),
    updated: relativeTime(row.lastUpdatedAt),
    updatedIso: row.lastUpdatedAt,
  };
}

// The compact status-strip counts (Draft / Submitted / Approved / Rejected / Void), computed from
// the rows already on the page - never a separate unbounded fetch.
export type WorkspaceSummaryCounts = { draft: number; submitted: number; approved: number; rejected: number; void: number };

export function summarizeWorkspaceRows(rows: InvoiceRowDto[]): WorkspaceSummaryCounts {
  const counts: WorkspaceSummaryCounts = { draft: 0, submitted: 0, approved: 0, rejected: 0, void: 0 };
  for (const row of rows) {
    if (row.status === "DRAFT") counts.draft += 1;
    if (row.status === "SUBMITTED") counts.submitted += 1;
    if (row.status === "APPROVED") counts.approved += 1;
    if (row.status === "REJECTED") counts.rejected += 1;
    if (row.status === "VOID") counts.void += 1;
  }
  return counts;
}
