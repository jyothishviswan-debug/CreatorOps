// Step 12C.2: the pure display rule for one Campaign Execution ring/row on
// the Overview `campaignboard` panel (rendered by src/ui/Overview.tsx's
// CampaignBoard). Lives beside the shared panel types so the UI component
// and its unit tests share ONE definition. A row is `truncated` when its
// Campaign has more obligations than the trusted read's documented bound -
// then `required` is only a lower bound, so no percentage/arc is derived
// from it: the ring shows the neutral "\u2014" with an empty arc and the
// total reads "N+". A non-truncated row keeps the accepted rounded
// percentage exactly as before.
export type CampaignBoardRow = { name: string; completed: number; required: number; truncated?: boolean };

export function campaignBoardRowDisplay(row: Pick<CampaignBoardRow, "completed" | "required" | "truncated">): { percentLabel: string; rate: number; requiredLabel: string; ariaLabel: string } {
  if (row.truncated) {
    const requiredLabel = `${row.required}+`;
    return { percentLabel: "\u2014", rate: 0, requiredLabel, ariaLabel: `${row.completed} of ${requiredLabel} completed (percentage unavailable, more obligations exist)` };
  }
  const rate = row.required > 0 ? row.completed / row.required : 0;
  return {
    percentLabel: row.required > 0 ? `${Math.round(rate * 100)}%` : "\u2014",
    rate,
    requiredLabel: String(row.required),
    ariaLabel: `${row.completed} of ${row.required} completed`,
  };
}
