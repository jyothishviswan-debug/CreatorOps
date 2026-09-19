// Step 12C.2: pure display decisions for Campaign Overview's execution
// slots when the trusted read hit its documented per-Campaign bound
// (`truncated`). Every figure derived from an incomplete obligation set is
// shown as a lower bound ("N+"), and no percentage/bar/donut segment is ever
// derived from an incomplete denominator. Kept out of src/app/campaigns/
// page.tsx so each wording/decision is exactly unit-testable, and built on
// the SAME "N+" convention (countLabel) Campaign Detail's downstream card
// already uses.
import { MAX_RELEVANT_ITEMS_PER_CAMPAIGN } from "@/server/campaigns/bounded-pages";

import type { CampaignBoardRow } from "@/features/shared/campaign-board";

import { countLabel, plural } from "./downstream-format";

// "12" or, when any contributing Campaign is truncated, "12+".
export function lowerBoundLabel(count: number, truncated: boolean): string {
  return countLabel(count, truncated);
}

// KPI "Content completed": "3 of 10" exact, "3 of 210+" when the total is
// only a lower bound.
export function approvedOfTotalLabel(approved: number, total: number, truncated: boolean): string {
  return `${approved} of ${countLabel(total, truncated)}`;
}

// The one sentence stating truncation, for the existing Campaign Execution
// `note` slot. null when nothing is truncated.
export function truncationNote(truncatedCampaignCount: number, bound = MAX_RELEVANT_ITEMS_PER_CAMPAIGN): string | null {
  if (truncatedCampaignCount <= 0) return null;
  return `Showing the first ${bound} obligations for ${truncatedCampaignCount} ${plural(truncatedCampaignCount, "Campaign")}; counts are lower bounds.`;
}

// Delivery State donut: shares are meaningless over an incomplete
// portfolio-wide denominator, so the donut renders its existing neutral
// "not available" form and this note says why. null when nothing is truncated.
export function deliveryStateUnavailableNote(truncatedCampaignCount: number, bound = MAX_RELEVANT_ITEMS_PER_CAMPAIGN): string | null {
  if (truncatedCampaignCount <= 0) return null;
  return `Unavailable: ${truncatedCampaignCount} active ${plural(truncatedCampaignCount, "Campaign")} ${plural(truncatedCampaignCount, "has", "have")} more than ${bound} obligations.`;
}

// Execution Exceptions `note`: "5 exceptions across 2 categories", or
// "5+ exceptions ..." when any exception count is a lower bound.
export function exceptionsNote(categoryCounts: readonly number[], truncated: boolean): string {
  if (categoryCounts.length === 0) return "No execution exceptions right now";
  const total = categoryCounts.reduce((sum, count) => sum + count, 0);
  return `${countLabel(total, truncated)} ${truncated ? "exceptions" : plural(total, "exception")} across ${categoryCounts.length} ${categoryCounts.length === 1 ? "category" : "categories"}`;
}

// One Campaign Execution row per Campaign. A truncated Campaign keeps its
// own (lower-bound) counts but is flagged so the board shows "N+" and an
// unavailable percentage instead of an exact-looking ring.
export function toCampaignBoardRows(rows: ReadonlyArray<{ campaignName: string; approvedCount: number; totalCount: number; truncated: boolean }>): CampaignBoardRow[] {
  return rows.map((row) => ({ name: row.campaignName, completed: row.approvedCount, required: row.totalCount, truncated: row.truncated }));
}
