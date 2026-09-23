// Step 15B: the PURE row -> view-model mapping of the Payables workspace. Everything a row renders is
// decided here (labels, chip specs, hrefs), so the table, the card view and the tests all read one
// source. It only ever reads fields of the allowlisted PayableRowDto: no restricted value, storage
// locator or scope internal can appear here.
//
// A row's `totalAmountMinorSigned` is `null` either when it is genuinely WITHHELD (the actor lacks
// `finance_amounts`) or, in principle, when it were a real zero - the DTO cannot tell those apart by
// itself. The workspace-level `amountsVisible` (PayablePermissionsDto.canViewAmounts, one flag for the
// whole read) is passed in explicitly so the two are never confused.
import type { PayableRowDto } from "@/server/finance-payables/client-dto";

import { commercialPeriodLabel, counterpartyTypeLabel, counterpartyTypeTone, determinationChip, formatSignedMoneyMinor, payableStatusChip, relativeTime, sourceTypeLabel, type ChipSpec, type PillTone } from "../format";

export const PAYABLES_BASE_HREF = "/finance/payables";
export const NEW_PAYABLE_HREF = `${PAYABLES_BASE_HREF}/new`;

export function payableDetailHref(payableRef: string): string {
  return `${PAYABLES_BASE_HREF}/${encodeURIComponent(payableRef)}`;
}

export type WorkspaceRowView = {
  key: string;
  payableRef: string;
  detailHref: string;
  counterpartyName: string;
  counterpartyType: string;
  counterpartyTypeLabel: string;
  counterpartyTypeTone: PillTone;
  commercialPeriod: string;
  sourceType: string;
  sourceTypeLabel: string;
  amountText: string;
  determination: ChipSpec;
  status: ChipSpec;
  updated: string;
  updatedIso: string;
  openReviewCount: number;
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

export function toWorkspaceRowView(row: PayableRowDto, amountsVisible: boolean): WorkspaceRowView {
  const name = row.counterparty.displayName?.trim() || "Unnamed counterparty";
  return {
    key: row.payableRef,
    payableRef: row.payableRef,
    detailHref: payableDetailHref(row.payableRef),
    counterpartyName: name,
    counterpartyType: row.counterparty.type,
    counterpartyTypeLabel: counterpartyTypeLabel(row.counterparty.type),
    counterpartyTypeTone: counterpartyTypeTone(row.counterparty.type),
    commercialPeriod: commercialPeriodLabel(row.commercialPeriod),
    sourceType: row.sourceType,
    sourceTypeLabel: sourceTypeLabel(row.sourceType),
    amountText: formatSignedMoneyMinor(row.totalAmountMinorSigned, row.currency, { amountsVisible }),
    determination: determinationChip(row.determinationState),
    status: payableStatusChip(row.status),
    updated: relativeTime(row.lastUpdatedAt),
    updatedIso: row.lastUpdatedAt,
    openReviewCount: row.openReviewCount,
  };
}

// The compact summary-strip counts (Draft / Finance review required / Ready for invoice / Void), computed
// from the rows already on the page - never a separate unbounded fetch.
export type WorkspaceSummaryCounts = { draft: number; financeReviewRequired: number; readyForInvoice: number; void: number };

export function summarizeWorkspaceRows(rows: PayableRowDto[]): WorkspaceSummaryCounts {
  const counts: WorkspaceSummaryCounts = { draft: 0, financeReviewRequired: 0, readyForInvoice: 0, void: 0 };
  for (const row of rows) {
    if (row.status === "DRAFT") counts.draft += 1;
    if (row.status === "READY_FOR_INVOICE") counts.readyForInvoice += 1;
    if (row.status === "VOID") counts.void += 1;
    if (row.determinationState === "FINANCE_REVIEW_REQUIRED") counts.financeReviewRequired += 1;
  }
  return counts;
}
