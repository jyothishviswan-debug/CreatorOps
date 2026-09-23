// Step 16B: the PURE view/adapter logic behind the Invoice detail page. Nothing here calls the
// network or touches the DOM.
import type { InvoiceDetailDto, InvoiceEventDto, InvoicePermissionsDto } from "@/server/finance-invoices/client-dto";
import type { InvoiceSourceRevisionDto } from "@/server/finance-invoices/invoice-lifecycle-service";

import { commercialPeriodLabel, eventKindLabel, formatFileSize, formatMoneyMinor, invoiceStatusChip, reconciliationChip, relativeTime, type ChipSpec } from "../format";

export type DetailTabKey = "summary" | "reconciliation" | "document" | "history";
export const DETAIL_TABS: Array<{ key: DetailTabKey; label: string }> = [
  { key: "summary", label: "Summary" },
  { key: "reconciliation", label: "Reconciliation" },
  { key: "document", label: "Document" },
  { key: "history", label: "History" },
];

export function parseDetailTab(raw: string | string[] | undefined): DetailTabKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return DETAIL_TABS.some((tab) => tab.key === value) ? (value as DetailTabKey) : "summary";
}

// --- Header -----------------------------------------------------------------------------------------------------------------------
export type DetailHeaderView = { title: string; secondary: string; statusChip: ChipSpec; reconciliationChip: ChipSpec };

export function detailHeaderView(head: InvoiceDetailDto["head"]): DetailHeaderView {
  return {
    title: head.counterparty.displayName ?? head.externalInvoiceNumber ?? head.invoiceRef,
    secondary: `${head.invoiceRef} · ${head.externalInvoiceNumber ?? "No invoice number yet"}`,
    statusChip: invoiceStatusChip(head.status),
    reconciliationChip: reconciliationChip(head.reconciliationState),
  };
}

// Actions depend on both the lifecycle status AND the exact server-computed permission - never a
// role-rank assumption. APPROVED and VOID are always fully read-only in this UI (section 10: no
// Payment creation surface here, and Void is deliberately not re-offered once Approved).
export type DetailActionVisibility = { canEdit: boolean; canSubmit: boolean; canApprove: boolean; canReject: boolean; canReopen: boolean; canVoid: boolean; canOverrideMismatch: boolean; readOnly: boolean };

export function detailActionVisibility(head: InvoiceDetailDto["head"], permissions: InvoicePermissionsDto): DetailActionVisibility {
  const none: DetailActionVisibility = { canEdit: false, canSubmit: false, canApprove: false, canReject: false, canReopen: false, canVoid: false, canOverrideMismatch: false, readOnly: true };
  if (head.status === "VOID" || head.status === "APPROVED") return none;
  if (head.status === "DRAFT") return { ...none, canEdit: permissions.canManage, canSubmit: permissions.canManage, canVoid: permissions.canVoid, readOnly: false };
  if (head.status === "SUBMITTED") return { ...none, canApprove: permissions.canApprove, canReject: permissions.canApprove, canVoid: permissions.canVoid, canOverrideMismatch: permissions.canOverrideMismatch, readOnly: false };
  // REJECTED
  return { ...none, canReopen: permissions.canManage, canVoid: permissions.canVoid, readOnly: false };
}

// --- Summary tab ------------------------------------------------------------------------------------------------------------------
export type SummaryRow = { label: string; value: string };

export function summaryRows(detail: InvoiceDetailDto): SummaryRow[] {
  const { head, selectedVersion } = detail;
  const rows: SummaryRow[] = [
    { label: "Invoice number", value: head.externalInvoiceNumber ?? "Not set" },
    { label: "Invoice date", value: selectedVersion?.invoiceDate ?? "Not set" },
    { label: "Received date", value: selectedVersion?.receivedDate ?? "—" },
    { label: "Currency", value: head.currency ?? "Not set" },
    { label: "Subtotal", value: formatMoneyMinor(selectedVersion?.subtotalMinor ?? null, head.currency, { amountsVisible: detail.amountsVisible }) },
    { label: "Declared taxes", value: formatMoneyMinor(taxLinesTotal(selectedVersion?.taxLines ?? []), head.currency, { amountsVisible: detail.amountsVisible }) },
    { label: "Total", value: formatMoneyMinor(head.declaredTotalMinor, head.currency, { amountsVisible: detail.amountsVisible }) },
    { label: "Due date", value: selectedVersion?.dueDate ?? "—" },
    { label: "Counterparty", value: head.counterparty.displayName ?? head.counterparty.ref },
    { label: "Commercial period", value: commercialPeriodLabel(head.commercialPeriod.periodKey) },
    { label: "Payable", value: selectedVersion ? `${selectedVersion.payablePin.payableRef} · v${selectedVersion.payablePin.payableVersion}` : head.payableRef },
    { label: "Created", value: relativeTime(head.createdAt) },
    { label: "Updated", value: relativeTime(head.updatedAt) },
  ];
  return rows;
}

function taxLinesTotal(lines: Array<{ amountMinor: number | null }>): number | null {
  if (lines.length === 0) return 0;
  if (lines.some((line) => line.amountMinor === null)) return null;
  return lines.reduce((sum, line) => sum + (line.amountMinor ?? 0), 0);
}

export type ApprovalReadinessView = {
  lifecycle: ChipSpec;
  reconciliation: ChipSpec;
  documentAttached: boolean;
  mismatchOverrideStatus: string;
  sourceRevisionState: string | null;
  eligibleForApproval: boolean;
};

export function approvalReadinessView(detail: InvoiceDetailDto, revision: InvoiceSourceRevisionDto | null): ApprovalReadinessView {
  const { head, selectedVersion } = detail;
  const hasUnresolvedBlocker = (selectedVersion?.reconciliation.findings ?? []).some((finding) => {
    if (finding.severity !== "BLOCKER") return false;
    if (finding.code === "TOTAL_AMOUNT_MISMATCH" && head.mismatchOverride?.forVersion === selectedVersion?.version) return false;
    return true;
  });
  return {
    lifecycle: invoiceStatusChip(head.status),
    reconciliation: reconciliationChip(head.reconciliationState),
    documentAttached: (selectedVersion?.document ?? null) !== null,
    mismatchOverrideStatus: head.mismatchOverride ? "Accepted with reason" : "None",
    sourceRevisionState: revision && revision.state !== "CURRENT" ? revision.state : null,
    eligibleForApproval: head.status === "SUBMITTED" && !hasUnresolvedBlocker,
  };
}

// --- Document tab -----------------------------------------------------------------------------------------------------------------
export type DocumentView = { fileName: string; mimeType: string; sizeText: string; sha256: string; storedAt: string; storedBy: string; version: number } | null;

export function documentView(detail: InvoiceDetailDto): DocumentView {
  const document = detail.selectedVersion?.document ?? null;
  if (!document) return null;
  return { fileName: document.fileName, mimeType: document.mimeType, sizeText: formatFileSize(document.sizeBytes), sha256: document.sha256, storedAt: relativeTime(document.storedAt), storedBy: document.storedByUserRef, version: detail.selectedVersion!.version };
}

// --- History tab ------------------------------------------------------------------------------------------------------------------
export type HistoryRow = { key: string; date: string; event: string; version: number; actor: string; reasonOrMetadata: string };

export function historyRows(events: InvoiceEventDto[]): HistoryRow[] {
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
  const fileName = metadata.fileName;
  if (typeof fileName === "string" && fileName.length > 0) return fileName;
  return "—";
}

// --- Edit / revision wording (section 16) -----------------------------------------------------------------------------------------
export function nextVersionWording(currentVersion: number): string {
  return `Saving creates Invoice version v${currentVersion + 1}.`;
}
