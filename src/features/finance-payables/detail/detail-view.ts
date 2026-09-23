// Step 15B: the PURE view/adapter logic behind the Payable detail page. Nothing here calls the network
// or touches the DOM.
import { commercialPeriodLabel, determinationChip, eventKindLabel, formatSignedMoneyMinor, payableStatusChip, relativeTime, sourceRefLabel, sourceTypeLabel, type ChipSpec } from "../format";
import type { PayableDetailDto, PayableEventDto, PayablePermissionsDto, PayableSourceRevisionDto } from "@/server/finance-payables/client-dto";

export type DetailTabKey = "summary" | "breakdown" | "source" | "history";
export const DETAIL_TABS: Array<{ key: DetailTabKey; label: string }> = [
  { key: "summary", label: "Summary" },
  { key: "breakdown", label: "Amount breakdown" },
  { key: "source", label: "Source evidence" },
  { key: "history", label: "History" },
];

export function parseDetailTab(raw: string | string[] | undefined): DetailTabKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return DETAIL_TABS.some((tab) => tab.key === value) ? (value as DetailTabKey) : "summary";
}

// --- Header ---------------------------------------------------------------------------------------------------------------------
export type DetailHeaderView = {
  title: string;
  secondary: string;
  statusChip: ChipSpec;
  determinationChip: ChipSpec;
};

export function detailHeaderView(head: PayableDetailDto["head"]): DetailHeaderView {
  return {
    title: head.counterparty.displayName ?? head.counterparty.ref,
    secondary: `${head.payableRef} · ${commercialPeriodLabel(head.commercialPeriod.periodKey)}`,
    statusChip: payableStatusChip(head.status),
    determinationChip: determinationChip(head.determinationState),
  };
}

export type DetailActionVisibility = { canEdit: boolean; canMarkReady: boolean; canVoid: boolean; readOnly: boolean };

// Actions depend on both the lifecycle status AND the exact server-computed permission - never a role
// rank assumption. VOID is always read-only; READY_FOR_INVOICE never re-exposes edit (no silent reopen).
export function detailActionVisibility(head: PayableDetailDto["head"], permissions: PayablePermissionsDto): DetailActionVisibility {
  if (head.status === "VOID") return { canEdit: false, canMarkReady: false, canVoid: false, readOnly: true };
  if (head.status === "READY_FOR_INVOICE") return { canEdit: false, canMarkReady: false, canVoid: permissions.canVoid, readOnly: false };
  return { canEdit: permissions.canManage, canMarkReady: permissions.canApprove, canVoid: permissions.canVoid, readOnly: false };
}

// --- Summary tab ------------------------------------------------------------------------------------------------------------------
export type SummaryRow = { label: string; value: string };

export function summaryRows(detail: PayableDetailDto): SummaryRow[] {
  const { head, selectedVersion, amountsVisible } = detail;
  const money = (value: number | null) => formatSignedMoneyMinor(value, head.currency, { amountsVisible });
  const rows: SummaryRow[] = [
    { label: "Counterparty", value: head.counterparty.displayName ?? head.counterparty.ref },
    { label: "Counterparty type", value: head.counterparty.type === "PARTNER" ? "Partner" : "Vendor" },
    { label: "Commercial period", value: commercialPeriodLabel(head.commercialPeriod.periodKey) },
    { label: "Agreement", value: `${head.agreementRef} · v${head.agreementVersion}` },
    { label: "Review / source", value: head.reviewRef ? `${head.reviewRef} · v${head.reviewVersion}` : sourceTypeLabel(head.sourceType) },
    { label: "Currency", value: head.currency },
    { label: "Determination", value: determinationChip(head.determinationState).label },
  ];
  // Step 15C section 17/22: service base / GST / TDS / expected net payment, visible on the
  // summary itself - never only on the breakdown tab.
  if (selectedVersion) {
    rows.push({ label: "Service base", value: money(selectedVersion.serviceBaseMinor) });
    rows.push({ label: "GST", value: money(selectedVersion.gstMinor) });
    rows.push({ label: "TDS", value: money(selectedVersion.tdsMinor) });
    rows.push({ label: "Expected net payment", value: money(selectedVersion.expectedNetPaymentMinor) });
  }
  rows.push({ label: "Created", value: relativeTime(head.createdAt) });
  rows.push({ label: "Updated", value: relativeTime(head.updatedAt) });
  return rows;
}

export type ReadinessView = {
  lifecycle: string;
  unresolvedCount: number;
  sourceRevisionState: string | null;
  eligibleForInvoice: boolean;
};

export function readinessView(detail: PayableDetailDto, revision: PayableSourceRevisionDto | null): ReadinessView {
  const { head, selectedVersion } = detail;
  return {
    lifecycle: payableStatusChip(head.status).label,
    unresolvedCount: head.openReviewCount,
    sourceRevisionState: revision && revision.state !== "CURRENT" ? revision.state : null,
    eligibleForInvoice: head.status === "DRAFT" && head.openReviewCount === 0 && (selectedVersion?.lines.length ?? 0) > 0 && (selectedVersion?.totalAmountMinorSigned ?? 0) >= 0,
  };
}

export function amountPreviewText(detail: PayableDetailDto): string {
  return formatSignedMoneyMinor(detail.head.totalAmountMinorSigned, detail.head.currency, { amountsVisible: detail.amountsVisible });
}

// --- History tab ------------------------------------------------------------------------------------------------------------------
export type HistoryRow = { key: string; date: string; event: string; version: number; actor: string; reasonOrMetadata: string };

export function historyRows(events: PayableEventDto[]): HistoryRow[] {
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
  const label = metadata.label;
  if (typeof label === "string" && label.length > 0) return label;
  return "—";
}

// --- Edit / revision wording (section 14) -----------------------------------------------------------------------------------------
export function nextVersionWording(currentVersion: number): string {
  return `Saving creates Payable version v${currentVersion + 1}.`;
}

export { sourceRefLabel };
