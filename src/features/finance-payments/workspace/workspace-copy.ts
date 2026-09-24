// Step 17B: the Payments workspace's honest wording about its BOUNDED read, as small PURE functions
// (unit-tested). Same style as the Finance Invoices/Payables workspace copy.
export type WorkspaceBound = { headsRead: number; headsTruncated: boolean };

export const WORKSPACE_TITLE = "Payments";
export const WORKSPACE_SUBTITLE = "Record and track payments against approved Invoices.";
export const WORKSPACE_TABLE_CAPTION = "Payments workspace";

export const WORKSPACE_PROJECTION_NOTE = "Status and amounts shown here are as of each Payment's last update. Open a Payment for its current state.";

export const DENIED_TITLE = "Access denied";
export const DENIED_DESCRIPTION = "You do not have access to this view.";
export const ERROR_TITLE = "Couldn’t load Payments.";
export const ERROR_DESCRIPTION = "Something went wrong while loading the Payments workspace.";
export const PAGE_ERROR_TITLE = "Couldn’t load Payments.";

export function incompleteListSentence(headsRead: number): string {
  return `Your scope has more Payments than the ${headsRead} most recently updated read, so this list is incomplete - narrow the filters to see older ones.`;
}

const plural = (count: number, singular: string, pluralForm = `${singular}s`) => (count === 1 ? singular : pluralForm);

// Integration note: unlike InvoiceWorkspaceDto/PayableWorkspaceDto, PaymentWorkspaceDto (Step 17A's
// own client-dto.ts) carries no `totalInBoundedSet` - only `rows` (this page) and `disclosure`
// (headsRead/headsTruncated of the whole scoped scan). This copy is therefore phrased off the
// current page's row count plus the scan disclosure, never a total the DTO does not provide.
export function workspaceCountCopy(input: WorkspaceBound & { pageShown: number }): string | null {
  if (!input.headsTruncated) return input.pageShown > 0 ? `${input.pageShown} ${plural(input.pageShown, "Payment")} shown.` : null;
  if (input.pageShown > 0) return `${input.pageShown} shown among the ${input.headsRead} most recently updated Payments read - the list may be incomplete.`;
  return `None found among the ${input.headsRead} most recently updated Payments read.`;
}

export function workspaceEmptyCopy(input: WorkspaceBound & { anyFilterActive: boolean; canManage: boolean }): { title: string; description: string } {
  const base = input.anyFilterActive
    ? "Try a different search or filter, or clear the filters."
    : input.canManage
      ? "Record a Payment against an approved Invoice."
      : "Payments you are authorized to see will appear here.";
  if (input.headsTruncated) return { title: "None found in the Payments read", description: `${incompleteListSentence(input.headsRead)} ${input.anyFilterActive ? base : ""}`.trim() };
  if (input.anyFilterActive) return { title: "No matching Payments", description: base };
  return { title: "No payments found", description: base };
}

export function pageStatusCopy(currentPage: number, shown: number): string {
  return `Page ${currentPage} · ${shown} shown`;
}

export const LOADING_ANNOUNCEMENT = "Loading Payments…";

export const FILTER_LABELS = {
  status: "Filter status",
  counterpartyType: "Filter Partner or Vendor",
  counterparty: "Search counterparty ref",
  invoiceRef: "Search Invoice ref",
} as const;

export const CLEAR_FILTERS_LABEL = "Clear filters";

// The compact status strip counts (Draft / Recorded / Confirmed / Failed / Void). These read the
// CURRENT filtered/bounded set already on the page - never a separate unbounded fetch. Settlement-
// state counts (Unpaid/Partially paid/Paid/Review required) are an INVOICE-level projection, not
// bounded at this workspace's own read, so they are deliberately not offered here (see
// workspace-query.ts's own comment on the same gap).
export function summaryStripNote(headsTruncated: boolean): string | null {
  return headsTruncated ? "Counts are of the Payments read, not a total." : null;
}
