import type { WorkspaceMode } from "@/server/partner-reviews/partner-review-workspace-service";

// Step 13C: the Workspace's honest wording about its BOUNDED read, as small PURE functions (unit-tested).
//
// The Workspace reads at most one bounded set of the month's reviews (HEAD_SCAN_CEILING) and filters / pages that set. When the read
// stopped early (`headsTruncated`) the list is INCOMPLETE: the count is only what was found among the reviews read, and an empty
// result is "none found in the reviews read" - never a certain "there are none". Region narrows the reviews already read (it does not
// change which reviews are read), so the only honest way to reach the rest is the Partner filter.

type Bound = { headsRead: number; headsTruncated: boolean };

export function incompleteListSentence(headsRead: number): string {
  return `The month has more reviews than the ${headsRead} read, so this list is incomplete - narrow by Partner to see the rest.`;
}

// The count line under the Workspace filters. null = nothing to say (no rows, nothing truncated).
export function workspaceCountCopy(input: Bound & { total: number }): string | null {
  if (!input.headsTruncated) return input.total > 0 ? `${input.total} in this view.` : null;
  const found = input.total > 0 ? `${input.total} in this view, from the first ${input.headsRead} reviews read.` : `None found in the first ${input.headsRead} reviews read.`;
  return `${found} ${incompleteListSentence(input.headsRead)}`;
}

const EMPTY_TITLE: Record<WorkspaceMode, string> = {
  "needs-review": "Nothing needs review",
  drafts: "No drafts or reviews in progress",
  finalized: "No finalized reviews",
  signal: "Nothing needs review",
};

// The empty state. Truncated: never a flat "there are none" - the reviews beyond the bound were not read.
export function workspaceEmptyCopy(input: Bound & { mode: WorkspaceMode; anyFilterActive: boolean; monthLabel: string | null }): { title: string; description: string } {
  const base = input.anyFilterActive ? "Try another Partner, region or month, or clear the filters." : `Nothing to show for ${input.monthLabel ?? "this month"} in your authorized scope.`;
  if (input.headsTruncated) return { title: "None found in the reviews read", description: `${incompleteListSentence(input.headsRead)} ${base}` };
  return { title: input.anyFilterActive ? "No matching reviews" : EMPTY_TITLE[input.mode], description: base };
}
