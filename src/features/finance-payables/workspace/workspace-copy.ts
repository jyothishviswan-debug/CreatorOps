// Step 15B: the Payables workspace's honest wording about its BOUNDED read, as small PURE functions
// (unit-tested). Same style as the Agreements / Partner Reviews workspace copy.
export type WorkspaceBound = { headsRead: number; headsTruncated: boolean };

export const WORKSPACE_TITLE = "Payables";
export const WORKSPACE_SUBTITLE = "Review Agreement-governed commercial evidence and prepare payable amounts for invoicing.";
export const WORKSPACE_TABLE_CAPTION = "Payables workspace";

export const WORKSPACE_PROJECTION_NOTE = "Status and amounts shown here are as of each Payable's last update. Open a Payable for its current state.";

export const DENIED_TITLE = "Access denied";
export const DENIED_DESCRIPTION = "You do not have access to this view.";
export const ERROR_TITLE = "Couldn’t load Payables.";
export const ERROR_DESCRIPTION = "Something went wrong while loading the Payables workspace.";
export const PAGE_ERROR_TITLE = "Couldn’t load Payables.";

export function incompleteListSentence(headsRead: number): string {
  return `Your scope has more Payables than the ${headsRead} most recently updated read, so this list is incomplete - narrow the filters to see older ones.`;
}

const plural = (count: number, singular: string, pluralForm = `${singular}s`) => (count === 1 ? singular : pluralForm);

export function workspaceCountCopy(input: WorkspaceBound & { total: number }): string | null {
  if (!input.headsTruncated) return input.total > 0 ? `${input.total} ${plural(input.total, "Payable")} in this view.` : null;
  if (input.total > 0) return `${input.total} found among the ${input.headsRead} most recently updated Payables read - the list may be incomplete.`;
  return `None found among the ${input.headsRead} most recently updated Payables read.`;
}

export function workspaceEmptyCopy(input: WorkspaceBound & { anyFilterActive: boolean; canManage: boolean }): { title: string; description: string } {
  const base = input.anyFilterActive
    ? "Try a different search or filter, or clear the filters."
    : input.canManage
      ? "Create a Payable from an eligible Agreement and finalized commercial evidence."
      : "Payables you are authorized to see will appear here.";
  if (input.headsTruncated) return { title: "None found in the Payables read", description: `${incompleteListSentence(input.headsRead)} ${input.anyFilterActive ? base : ""}`.trim() };
  if (input.anyFilterActive) return { title: "No matching Payables", description: base };
  return { title: "No Payables found", description: base };
}

export function pageStatusCopy(currentPage: number, shown: number): string {
  return `Page ${currentPage} · ${shown} shown`;
}

export const LOADING_ANNOUNCEMENT = "Loading Payables…";

export const FILTER_LABELS = {
  status: "Filter status",
  counterpartyType: "Filter Partner or Vendor",
  counterparty: "Search counterparty",
  commercialPeriod: "Filter commercial period",
} as const;

export const CLEAR_FILTERS_LABEL = "Clear filters";

// The compact summary-strip counts (Draft / Finance review required / Ready for invoice / Void). These
// read the CURRENT filtered/bounded set already on the page - never a separate unbounded fetch - so the
// numbers are only ever "of what was read", exactly like the workspace's own count line.
export function summaryStripNote(headsTruncated: boolean): string | null {
  return headsTruncated ? "Counts are of the Payables read, not a total." : null;
}
