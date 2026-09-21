// Step 14B: the Agreements workspace's honest wording about its BOUNDED read, as small PURE functions (unit-tested).
// Same style as the Partner Reviews workspace copy.
//
// The service reads at most one bounded, scope-first set of the most recently updated Agreements (`headsRead`, ceiling
// `scanLimit`) and filters / pages that set. When the read stopped early (`headsTruncated`) the list is INCOMPLETE:
// the count is only what was found among the Agreements read, and an empty result is "none found in the Agreements read" -
// never a certain "there are none" and never an exact-looking total. Filters narrow the set already read (they do not
// change which Agreements are read), so the only honest way to reach older ones is a tighter filter.

export type WorkspaceBound = { headsRead: number; headsTruncated: boolean };

export const WORKSPACE_TITLE = "Agreements";
export const WORKSPACE_DESCRIPTION = "Agreements for every Partner and Vendor you are authorized to see.";
export const WORKSPACE_TABLE_CAPTION = "Agreements workspace";

// The list is a projection: honest about when its facts were last written.
export const WORKSPACE_PROJECTION_NOTE = "Status, dates and extraction shown here are as of each Agreement's last update. Open an Agreement for its current state.";

export const DENIED_TITLE = "Access denied";
export const DENIED_DESCRIPTION = "You do not have access to this view.";
export const ERROR_TITLE = "Couldn’t load Agreements.";
export const ERROR_DESCRIPTION = "Something went wrong while loading the Agreements workspace.";
export const PAGE_ERROR_TITLE = "Couldn’t load Agreements.";

export function incompleteListSentence(headsRead: number): string {
  return `Your scope has more Agreements than the ${headsRead} most recently updated read, so this list is incomplete - narrow the filters to see older ones.`;
}

const plural = (count: number, singular: string, pluralForm = `${singular}s`) => (count === 1 ? singular : pluralForm);

// The count line under the toolbar (announced politely). null = nothing to say (no rows, nothing truncated).
export function workspaceCountCopy(input: WorkspaceBound & { total: number }): string | null {
  if (!input.headsTruncated) return input.total > 0 ? `${input.total} ${plural(input.total, "Agreement")} in this view.` : null;
  if (input.total > 0) return `${input.total} found among the ${input.headsRead} most recently updated Agreements read - the list may be incomplete.`;
  return `None found among the ${input.headsRead} most recently updated Agreements read.`;
}

// The empty state. Truncated: never a flat "there are none" - the Agreements beyond the bound were not read.
export function workspaceEmptyCopy(input: WorkspaceBound & { anyFilterActive: boolean; canManage: boolean }): { title: string; description: string } {
  const base = input.anyFilterActive
    ? "Try a different search or filter, or clear the filters."
    : input.canManage
      ? "Create the first Agreement for a Partner or Vendor to see it here."
      : "Agreements you are authorized to see will appear here.";
  if (input.headsTruncated) return { title: "None found in the Agreements read", description: `${incompleteListSentence(input.headsRead)} ${input.anyFilterActive ? base : ""}`.trim() };
  if (input.anyFilterActive) return { title: "No matching Agreements", description: base };
  return { title: "No Agreements yet", description: base };
}

// The footer status line: which page, how many rows on it.
export function pageStatusCopy(currentPage: number, shown: number): string {
  return `Page ${currentPage} · ${shown} shown`;
}

// The polite live-region text while the list is being refreshed for new filters or a new page.
export const LOADING_ANNOUNCEMENT = "Loading Agreements…";

// Filter / control labels (single source for the toolbar and the tests).
export const FILTER_LABELS = {
  search: "Search Partner or Vendor",
  lifecycle: "Filter lifecycle",
  counterpartyType: "Filter Partner or Vendor",
  platform: "Filter platform",
  period: "Filter effective period",
  month: "Effective month",
  discrepancy: "Open discrepancies only",
} as const;

export const CLEAR_FILTERS_LABEL = "Clear filters";
