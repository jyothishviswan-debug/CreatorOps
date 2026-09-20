import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import type { PartnerDoc } from "@/server/partners/types";

import type { CandidateGroup } from "./needs-review-candidates";
import { existingReviewRefs, MONTH_OPTIONS_LIMIT, scanHeads, scanScopedAssignmentCandidates, verifyLiveScope, type ScopeContext } from "./review-scan";
import type { MonthResolutionDto } from "./ui-dto";
import { monthLabel, type MonthParam } from "./ui-params";

// Step 13B: the shared, bounded context every Overview / Workspace request starts
// from: the actor's scope, the review months that exist in authorized scope, the
// Needs Review candidates (when the view needs them) and the resolved month.
//
// Month rule (documented, tested): an EXPLICIT valid `?month` is used exactly as
// given - never silently changed. With no usable month the default is the latest
// month that has a review head in authorized scope, else the latest candidate
// month, else "no review months yet" - never the (probably empty) current calendar
// month.

export type LiveCandidate = CandidateGroup & { partner: PartnerDoc };

export type ViewContext = {
  scope: ScopeContext;
  months: MonthResolutionDto;
  // Partner-months (live Partner scope verified, no review head yet) - empty when the scan was not needed/run.
  candidates: LiveCandidate[];
  candidateScan: { scanned: number; truncated: boolean } | null;
};

export type CandidateNeed = "always" | "if_no_reviews" | "never";

export async function loadScopeContext(actor: ActorContext): Promise<ScopeContext> {
  const grants = await getActorScopeGrants(actor);
  return { actorUid: actor.uid, grants, hasGlobal: hasGlobalScope(grants) };
}

// Pure: turns the discovered months into the resolution the UI shows.
export function resolveMonths(input: { requested: MonthParam; headMonths: string[]; candidateMonths: string[] }): MonthResolutionDto {
  const distinct = new Set<string>([...input.headMonths, ...input.candidateMonths]);
  if (input.requested.state === "valid") distinct.add(input.requested.month);
  const options = [...distinct]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, MONTH_OPTIONS_LIMIT + (input.requested.state === "valid" ? 1 : 0));

  let resolved: string | null;
  let source: MonthResolutionDto["source"];
  if (input.requested.state === "valid") {
    resolved = input.requested.month;
    source = "explicit";
  } else if (input.headMonths.length > 0) {
    resolved = [...input.headMonths].sort().at(-1)!;
    source = "latest_review";
  } else if (input.candidateMonths.length > 0) {
    resolved = [...input.candidateMonths].sort().at(-1)!;
    source = "latest_candidate";
  } else {
    resolved = null;
    source = "none";
  }
  // The explicit month must always be selectable even if it fell outside the bounded option list.
  if (resolved && !options.includes(resolved)) options.push(resolved);
  options.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  return {
    resolved,
    label: resolved ? monthLabel(resolved) : null,
    source,
    invalidRequested: input.requested.state === "invalid",
    options: options.map((month) => ({ month, label: monthLabel(month) })),
  };
}

export async function loadViewContext(actor: ActorContext, requested: MonthParam, options: { candidates: CandidateNeed; partnerRef?: string }): Promise<ViewContext> {
  const scope = await loadScopeContext(actor);

  // Review months: newest first, from a bounded head scan whose Partners are all re-verified live.
  const monthScan = await scanHeads(scope, { ceiling: 300, distinctMonthLimit: MONTH_OPTIONS_LIMIT, partnerRef: undefined });
  const liveForMonths = await verifyLiveScope(scope, monthScan.heads.map((head) => head.partnerRef));
  const headMonths = [...new Set(monthScan.heads.filter((head) => liveForMonths.has(head.partnerRef)).map((head) => head.periodKey))];

  let candidates: LiveCandidate[] = [];
  let candidateScan: ViewContext["candidateScan"] = null;
  const needCandidates = options.candidates === "always" || (options.candidates === "if_no_reviews" && headMonths.length === 0);
  if (needCandidates) {
    const scan = await scanScopedAssignmentCandidates(scope, { partnerRef: options.partnerRef });
    candidateScan = { scanned: scan.scanned, truncated: scan.truncated };
    const livePartners = await verifyLiveScope(scope, scan.groups.map((group) => group.partnerRef));
    const inScope = scan.groups.filter((group) => livePartners.has(group.partnerRef));
    const existing = await existingReviewRefs(inScope.map((group) => group.reviewRef));
    candidates = inScope.filter((group) => !existing.has(group.reviewRef)).map((group) => ({ ...group, partner: livePartners.get(group.partnerRef)! }));
  }

  const months = resolveMonths({ requested, headMonths, candidateMonths: [...new Set(candidates.map((candidate) => candidate.periodKey))] });
  return { scope, months, candidates, candidateScan };
}
