import type { ActorContext } from "@/server/authz/types";
import { getPartnerReviewHeadDoc } from "./firestore";
import { getReviewActionPermissions } from "./partner-review-permissions";
import { loadAuthorizedPartner, requirePartnerReviewsFeatureAccess } from "./partner-reviews-gate";
import { reviewRefFor } from "./period";
import { buildHistoryRows, buildHistoryWindow, resolveHistoryMonth, HISTORY_WINDOW_MONTHS, type PartnerHistoryMonthRowDto, type PartnerHistoryWindow } from "./partner-history-model";
import { buildReviewRow, isStaleHintState } from "./review-rows";
import { resolveDisplays, scanHeads, scanPartnerAssignmentMonths, CANDIDATE_SCAN_CEILING } from "./review-scan";
import { loadScopeContext } from "./review-view-context";
import { partnerReviewsUnauthorizedResult, type PartnerReviewHeadDoc, type PartnerReviewsServiceResult } from "./types";
import type { ReviewActionPermissions } from "./ui-dto";
import { monthLabel, type MonthParam } from "./ui-params";

// Step 13B: the trusted read behind the Partner-wise monthly history page
// (/partner-reviews/partner/[partnerId]).
//
// Trust chain, in order (each step fails closed):
//   1. authentication + the `partner_reviews` feature (explicit grant);
//   2. the LIVE Partner is loaded and the accepted Partner Record Scope applied.
//      An UNKNOWN Partner and an OUT-OF-SCOPE Partner are one and the same
//      neutral outcome (scope_denied) - never a 404 for one and a denial for the
//      other - and the result names no Partner;
//   3. ONE bounded head query for that Partner (accepted scoped-list machinery,
//      newest month first) reading only stored display projections;
//   4. ONE bounded Assignment scan by partnerRef (the Partner is already
//      authorized) to derive months with in-period evidence but no review;
//   5. NO per-month detail, NO version read for a stored-display head and NO
//      freshness recomputation: the evidence collector is never reached here (a
//      static test and a runtime spy prove it). Full detail loads only when the
//      user opens one monthly review.

export type PartnerHistoryDto = {
  partner: { partnerRef: string; displayName: string; regions: string[] };
  month: { selected: string | null; label: string | null; source: "explicit" | "latest_review" | "latest_candidate" | "none"; invalidRequested: boolean };
  // The selected month's row (header block: Open monthly review / Generate Review).
  selected: PartnerHistoryMonthRowDto | null;
  // Bounded 12-calendar-month window, newest first, with every month present (a month with no review is "No review"/"Needs review").
  window: PartnerHistoryWindow | null;
  rows: PartnerHistoryMonthRowDto[];
  latestReviewMonth: string | null;
  // Recorded freshness hints across the window's reviews (counts only, "as of last check").
  freshnessSummary: { reviews: number; behindUpstream: number; notRecorded: number };
  permissions: ReviewActionPermissions;
  disclosure: { assignmentsScanned: number; assignmentScanTruncated: boolean; scanLimit: number; windowMonths: number };
};

// How many heads one history read looks at (the window is 12 calendar months; the
// surplus reveals whether older reviews exist).
const HISTORY_HEAD_READ = 30;

export async function getPartnerReviewHistory(actor: ActorContext | null, partnerRef: unknown, input: { month: MonthParam; until: MonthParam }): Promise<PartnerReviewsServiceResult<PartnerHistoryDto>> {
  const gate = await requirePartnerReviewsFeatureAccess(actor);
  if (!gate.ok) return partnerReviewsUnauthorizedResult(gate.reason);

  if (typeof partnerRef !== "string" || partnerRef.length === 0 || partnerRef.length > 200) return partnerReviewsUnauthorizedResult("scope_denied");
  const loaded = await loadAuthorizedPartner(actor!, partnerRef);
  if (!loaded.ok) return partnerReviewsUnauthorizedResult("scope_denied");
  const partner = loaded.partner;

  const scope = await loadScopeContext(actor!);
  const permissions = await getReviewActionPermissions(actor);

  const until = input.until.state === "valid" ? input.until.month : undefined;
  const [headScan, assignmentScan] = await Promise.all([
    scanHeads(scope, { partnerRef: partner.partnerRef, partnerAuthorized: true, periodKeyMax: until, ceiling: HISTORY_HEAD_READ }),
    scanPartnerAssignmentMonths(partner.partnerRef),
  ]);

  const headsByMonth = new Map<string, PartnerReviewHeadDoc>();
  for (const head of headScan.heads) headsByMonth.set(head.periodKey, head);
  const headMonths = [...headsByMonth.keys()];

  const headlessCandidates = new Map(assignmentScan.groups.filter((group) => !headsByMonth.has(group.periodKey) && (!until || group.periodKey <= until)).map((group) => [group.periodKey, group]));
  // A candidate month can also be one that has a head OLDER than the head read reached; the direct
  // deterministic-ref lookup below covers the explicitly selected month, and older months are reachable via `until`.
  const candidateMonths = [...headlessCandidates.keys()];

  const knownMonths = [...headMonths, ...candidateMonths];
  const end = until ?? (knownMonths.length > 0 ? knownMonths.sort().at(-1)! : null);
  const requested = input.month.state === "valid" ? input.month.month : null;
  const resolved = resolveHistoryMonth({ requested, headMonths, candidateMonths, end });

  let window: PartnerHistoryWindow | null = null;
  let rows: PartnerHistoryMonthRowDto[] = [];
  if (end) {
    // Everything older than the window: heads read beyond it + candidate months older than it.
    window = buildHistoryWindow({ end, olderMonths: [...headMonths, ...candidateMonths] });
    const inWindowHeads = new Map([...headsByMonth].filter(([month]) => window!.months.includes(month)));
    const displays = await resolveDisplays([...inWindowHeads.values()]);
    rows = buildHistoryRows({ months: window.months, heads: inWindowHeads, displays, candidates: headlessCandidates, partnerDisplayName: partner.displayName });
    // The head read is bounded: when it stopped early there ARE older reviews.
    if (headScan.truncated && !window.hasOlder) {
      const oldestRead = headScan.heads.at(-1)?.periodKey ?? null;
      window = { ...window, hasOlder: oldestRead !== null && oldestRead < window.start, olderUntil: oldestRead !== null && oldestRead < window.start ? oldestRead : null };
    }
  }

  // The selected month's row: in the window -> reuse it; otherwise (an explicit month outside it) read
  // that one review head directly by its deterministic ref.
  let selected: PartnerHistoryMonthRowDto | null = null;
  if (resolved.month) {
    selected = rows.find((row) => row.periodKey === resolved.month) ?? null;
    if (!selected) {
      const head = await getPartnerReviewHeadDoc(reviewRefFor(partner.partnerRef, resolved.month));
      if (head) {
        const displays = await resolveDisplays([head]);
        const row = buildReviewRow(head, displays.get(head.reviewRef), partner.displayName);
        selected = { periodKey: resolved.month, label: monthLabel(resolved.month), state: "review", row, revised: row.revisionCount > 0 };
      } else {
        const candidate = assignmentScan.groups.find((group) => group.periodKey === resolved.month);
        selected = buildHistoryRows({ months: [resolved.month], heads: new Map(), displays: new Map(), candidates: new Map(candidate ? [[resolved.month, candidate]] : []), partnerDisplayName: partner.displayName })[0]!;
      }
    }
  }

  const reviewRows = rows.filter((row) => row.state === "review" && row.row);
  const latestReviewMonth = headMonths.length > 0 ? [...headMonths].sort().at(-1)! : null;

  return {
    ok: true,
    data: {
      partner: { partnerRef: partner.partnerRef, displayName: partner.displayName, regions: partner.regionIds },
      month: { selected: resolved.month, label: resolved.month ? monthLabel(resolved.month) : null, source: resolved.source, invalidRequested: input.month.state === "invalid" },
      selected,
      window,
      rows,
      latestReviewMonth,
      freshnessSummary: {
        reviews: reviewRows.length,
        behindUpstream: reviewRows.filter((row) => isStaleHintState(row.row!.freshnessHint?.state)).length,
        notRecorded: reviewRows.filter((row) => row.row!.freshnessHint === null).length,
      },
      permissions,
      disclosure: { assignmentsScanned: assignmentScan.scanned, assignmentScanTruncated: assignmentScan.truncated, scanLimit: CANDIDATE_SCAN_CEILING, windowMonths: HISTORY_WINDOW_MONTHS },
    },
  };
}
