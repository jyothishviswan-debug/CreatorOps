import type { CandidateGroup } from "./needs-review-candidates";
import { buildCandidateRow, buildReviewRow } from "./review-rows";
import type { ResolvedDisplay } from "./review-scan";
import type { PartnerReviewHeadDoc } from "./types";
import type { ReviewListRowDto } from "./ui-dto";
import { monthLabel, monthWindow } from "./ui-params";

// Step 13B: the PURE assembly of the Partner-wise monthly history from heads
// (stored display projections) and Assignment-derived candidate months. It reads
// nothing: a month with no review is "Needs review" (in-period Assignments exist,
// no review yet) or "No review" (nothing found) - NEVER a zero, and never a
// fabricated value.

export const HISTORY_WINDOW_MONTHS = 12;

export type PartnerHistoryMonthState = "review" | "needs_review" | "no_review";

export type PartnerHistoryMonthRowDto = {
  periodKey: string;
  label: string;
  state: PartnerHistoryMonthState;
  // The review (or the Needs Review candidate) behind this month; null = "No review".
  row: ReviewListRowDto | null;
  // The month has been revised (a later version exists) - the older version stays preserved and reachable.
  revised: boolean;
};

export type PartnerHistoryWindow = {
  // The calendar months shown, newest first (at most HISTORY_WINDOW_MONTHS).
  months: string[];
  end: string;
  start: string;
  // A review or a candidate month exists OLDER than the window; `olderUntil` is the window end that reaches it.
  hasOlder: boolean;
  olderUntil: string | null;
};

export function buildHistoryRows(input: {
  months: string[];
  heads: ReadonlyMap<string, PartnerReviewHeadDoc>;
  displays: ReadonlyMap<string, ResolvedDisplay>;
  candidates: ReadonlyMap<string, CandidateGroup>;
  partnerDisplayName: string;
}): PartnerHistoryMonthRowDto[] {
  return input.months.map((periodKey) => {
    const head = input.heads.get(periodKey);
    if (head) {
      const row = buildReviewRow(head, input.displays.get(head.reviewRef), input.partnerDisplayName);
      return { periodKey, label: monthLabel(periodKey), state: "review", row, revised: row.revisionCount > 0 };
    }
    const candidate = input.candidates.get(periodKey);
    if (candidate) return { periodKey, label: monthLabel(periodKey), state: "needs_review", row: buildCandidateRow(candidate, { displayName: input.partnerDisplayName }), revised: false };
    return { periodKey, label: monthLabel(periodKey), state: "no_review", row: null, revised: false };
  });
}

// The window: `end` = the explicit `until` when given, else the newest month known
// (review head or candidate). Older content is disclosed, not silently dropped.
export function buildHistoryWindow(input: { end: string; olderMonths: string[] }): PartnerHistoryWindow {
  const months = monthWindow(input.end, HISTORY_WINDOW_MONTHS);
  const start = months[months.length - 1]!;
  const older = input.olderMonths.filter((month) => month < start).sort();
  const newestOlder = older.at(-1) ?? null;
  return { months, end: input.end, start, hasOlder: newestOlder !== null, olderUntil: newestOlder };
}

// Resolves the selected month. An explicit valid month is used exactly as given;
// otherwise: the Partner's latest existing review month <= the window end, else the
// latest candidate month <= the window end, else none.
export function resolveHistoryMonth(input: { requested: string | null; headMonths: string[]; candidateMonths: string[]; end: string | null }): { month: string | null; source: "explicit" | "latest_review" | "latest_candidate" | "none" } {
  if (input.requested) return { month: input.requested, source: "explicit" };
  const bounded = (months: string[]) => months.filter((month) => input.end === null || month <= input.end).sort();
  const heads = bounded(input.headMonths);
  if (heads.length > 0) return { month: heads.at(-1)!, source: "latest_review" };
  const candidates = bounded(input.candidateMonths);
  if (candidates.length > 0) return { month: candidates.at(-1)!, source: "latest_candidate" };
  return { month: null, source: "none" };
}
