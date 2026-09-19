// Step 12C: the one new trusted, read-only Campaign/Assignment/Content/
// Analytics integration surface behind the real Campaign Overview page
// (src/app/campaigns/page.tsx). Purely additive - never calls any
// Campaign/Assignment/Content lifecycle-mutation function, never imports
// anything Finance-shaped. Composes ONLY already-scoped, already-
// authorized reads (listAssignmentDocs/listContentDocs/
// evaluateCampaignAnalyticsReadiness/listCampaigns), the same "join other
// domains' own canonical data via campaignRef/assignmentRef, never add a
// field to Campaign's own schema" discipline the task's own ground truth
// spells out.
//
// "Execution obligation" - the ONE canonical definition, defined once,
// reused everywhere in this file and never re-derived ad hoc: an
// Assignment under an ACTIVE Campaign whose status is ASSIGNED, ACCEPTED,
// IN_PROGRESS or COMPLETED (DRAFT and CANCELLED Assignments never
// represent a real obligation - DRAFT hasn't been issued yet, CANCELLED
// was withdrawn).
import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";

import { evaluateCampaignAnalyticsReadiness, type CampaignAnalyticsReadiness } from "@/server/analytics/campaign-readiness";
import { listAssignmentDocs, type AssignmentListCursor } from "@/server/assignments/firestore";
import type { AssignmentStatus } from "@/server/assignments/types";
import { listContentDocs, type ContentListCursor } from "@/server/content/firestore";
import type { ContentStatus } from "@/server/content/types";

import { collectBounded, MAX_RELEVANT_ITEMS_PER_CAMPAIGN, MAX_SCANNED_ROWS_PER_CAMPAIGN } from "./bounded-pages";
import type { CampaignDto } from "./client-dto";
import { getCampaign, listCampaigns } from "./campaign-service";
import { requireCampaignsFeatureAccess } from "./campaigns-gate";
import { campaignsUnauthorizedResult, type CampaignsServiceResult } from "./types";

export const EXECUTION_OBLIGATION_ASSIGNMENT_STATUSES: ReadonlySet<AssignmentStatus> = new Set(["ASSIGNED", "ACCEPTED", "IN_PROGRESS", "COMPLETED"]);

// Firm, documented bound on RELEVANT obligations read per Campaign (see
// ./bounded-pages.ts): the list functions clamp one page to 100 rows, so the
// bound is reached by following deterministic cursors page by page (never a
// fetch-all, never browser fan-out). DRAFT/CANCELLED Assignments are not
// obligations and never consume this budget. A hard scan ceiling
// (MAX_SCANNED_ROWS_PER_CAMPAIGN = 500 rows per collection) additionally
// caps how much is ever read. A Campaign that exceeds either is reported
// with an explicit `truncated` flag and every count derived from it is a
// lower bound - never presented as exact. If a real deployment's
// per-Campaign obligation count ever needs to exceed this, that's a signal
// to build a persisted projection, not to quietly raise this number.
export const MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY = MAX_RELEVANT_ITEMS_PER_CAMPAIGN;
export { MAX_SCANNED_ROWS_PER_CAMPAIGN };

// Firm, documented bound on the portfolio-wide ACTIVE Campaign scan: 2
// pages x 100 = 200 Campaigns max. Emulator-scale data is small; if a
// real deployment's actor-visible ACTIVE Campaign count ever needs to
// exceed this, that's the same signal as above.
const MAX_ACTIVE_CAMPAIGN_PAGES = 2;
const ACTIVE_CAMPAIGN_PAGE_SIZE = 100;

export type CampaignExecutionObligation = {
  assignmentRef: string;
  partnerRef: string;
  dueAt: string | null;
  assignmentStatus: AssignmentStatus;
  contentStatus: ContentStatus | null;
  contentCurrentLinksCount: number;
};

export type CampaignExecutionSummary = {
  campaignRef: string;
  totalObligations: number;
  approvedCount: number;
  distinctPartnerCount: number;
  overdueCount: number;
  deliveryState: { completed: number; inProgress: number; notStarted: number };
  underReviewCount: number;
  revisionRequestedCount: number;
  analyticsReadiness: CampaignAnalyticsReadiness;
  sourceLinksComplete: boolean;
  // Step 12C.2: true when this Campaign has MORE than the bounded number of
  // obligations (or a scan ceiling was hit) - every count above is then a
  // lower bound over the first MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY
  // obligations, never the exact total.
  truncated: boolean;
};

export type CampaignExecutionOverview = {
  activeCampaignCount: number;
  distinctAssignedPartnerCount: number;
  totalObligations: number;
  approvedObligations: number;
  overdueObligations: number;
  // `truncated` per Campaign: totalCount/approvedCount are then lower bounds
  // over the first MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY obligations.
  perCampaignExecution: Array<{ campaignRef: string; campaignName: string; approvedCount: number; totalCount: number; truncated: boolean }>;
  deliveryState: { completed: number; inProgress: number; notStarted: number };
  trackingReadiness: {
    trackingConfiguredRow: { label: string; detail: string; badge: string };
    sourceLinksCompleteRow: { label: string; detail: string; badge: string };
    reportingEligibleRow: { label: string; detail: string; badge: string };
    campaignsUnstaffedRow: { label: string; detail: string; badge: string };
  };
  executionExceptions: { overdueContent: number; awaitingReview: number; changesRequested: number; campaignsWithoutAssignments: number };
  // Step 12C.2: true when ANY contributing Campaign is truncated - every
  // portfolio total above (obligations, approved, overdue, distinct
  // Partners, delivery state, exception counts) is then a lower bound, and
  // no exact-looking percentage may be derived from it. `campaignsWithout
  // Assignments` stays exact: a truncated Campaign is never "unstaffed".
  truncated: boolean;
  truncatedCampaignCount: number;
};

// ---- Overdue / delivery-state classification (pure, unit-tested) --------

// `nowIso` is always server time (`new Date().toISOString()` at call
// time) supplied by the caller - never client-supplied - kept as an
// explicit parameter here purely so this rule is independently, exactly
// unit-testable against synthetic data without a real clock.
export function isObligationOverdue(obligation: CampaignExecutionObligation, nowIso: string): boolean {
  if (!obligation.dueAt) return false;
  if (obligation.dueAt >= nowIso) return false; // ISO 8601 timestamps compare lexicographically like dates.
  if (obligation.assignmentStatus === "COMPLETED" || obligation.assignmentStatus === "CANCELLED") return false;
  if (obligation.contentStatus === "APPROVED") return false;
  return true;
}

// Precedence, exactly as locked: completed beats inProgress beats
// notStarted - never double-counted, always mutually exclusive. Every
// real obligation's assignmentStatus is already one of
// EXECUTION_OBLIGATION_ASSIGNMENT_STATUSES (DRAFT/CANCELLED Assignments
// never become an obligation in the first place - see
// buildCampaignObligations below), so "notStarted" is this function's
// only remaining fallback and is always reachable by ASSIGNED/ACCEPTED.
export function classifyObligationDeliveryState(obligation: CampaignExecutionObligation): "completed" | "inProgress" | "notStarted" {
  if (obligation.assignmentStatus === "COMPLETED" || obligation.contentStatus === "APPROVED") return "completed";
  if (obligation.assignmentStatus === "IN_PROGRESS" || obligation.contentStatus === "UNDER_REVIEW" || obligation.contentStatus === "REVISION_REQUESTED") return "inProgress";
  return "notStarted";
}

// ---- Shared fetch-and-join primitive (never duplicated between the
// per-Campaign and portfolio functions) ------------------------------

type ObligationScope = { actorUid: string; grants: Awaited<ReturnType<typeof getActorScopeGrants>>; hasGlobal: boolean };

// Step 12C.2: cursor-followed, scope-constrained, bounded reads (see
// ./bounded-pages.ts) - NOT a single list call: listAssignmentDocs/
// listContentDocs clamp one page to 100 rows, so a bare `limit: 200` only
// ever read the first 100. Assignments are paged (100/page, newest first)
// until MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY RELEVANT obligations are found -
// DRAFT/CANCELLED rows are skipped and never consume that budget - or the
// MAX_SCANNED_ROWS_PER_CAMPAIGN ceiling is reached. `truncated` is true when
// a further relevant obligation exists beyond the kept ones, or when the
// scan ceiling was hit with pages remaining. Content threads are then
// fetched with the same cursor helper (campaignRef-scoped, joined by
// assignmentRef client-side - never an N+1 per-Assignment lookup) and, if
// THEIR scan ceiling is hit with pages remaining, the Campaign is also
// flagged truncated (an obligation's thread might be missing from the join).
export type CampaignObligationsResult = { obligations: CampaignExecutionObligation[]; truncated: boolean };

async function buildCampaignObligations(scope: ObligationScope, campaignRef: string): Promise<CampaignObligationsResult> {
  const assignmentResult = await collectBounded({
    fetchPage: async (limit, cursor: AssignmentListCursor | undefined) => {
      const page = await listAssignmentDocs({ actorUid: scope.actorUid, grants: scope.grants, hasGlobal: scope.hasGlobal, campaignRef, limit, cursor });
      return { items: page.assignments, nextCursor: page.nextCursor };
    },
    select: (a) => (EXECUTION_OBLIGATION_ASSIGNMENT_STATUSES.has(a.status) ? a : null),
    maxItems: MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY,
    maxScannedRows: MAX_SCANNED_ROWS_PER_CAMPAIGN,
  });
  const obligationAssignments = assignmentResult.items;
  if (obligationAssignments.length === 0) return { obligations: [], truncated: assignmentResult.truncated };

  const contentResult = await collectBounded({
    fetchPage: async (limit, cursor: ContentListCursor | undefined) => {
      const page = await listContentDocs({ actorUid: scope.actorUid, grants: scope.grants, hasGlobal: scope.hasGlobal, campaignRef, limit, cursor });
      return { items: page.content, nextCursor: page.nextCursor };
    },
    select: (c) => c,
    maxItems: MAX_SCANNED_ROWS_PER_CAMPAIGN,
    maxScannedRows: MAX_SCANNED_ROWS_PER_CAMPAIGN,
  });
  const contentByAssignmentRef = new Map(contentResult.items.map((c) => [c.assignmentRef, c]));

  const obligations = obligationAssignments.map((a) => {
    const content = contentByAssignmentRef.get(a.assignmentRef) ?? null;
    return {
      assignmentRef: a.assignmentRef,
      partnerRef: a.partnerRef,
      dueAt: a.brief.dueAt,
      assignmentStatus: a.status,
      contentStatus: content?.status ?? null,
      contentCurrentLinksCount: content?.currentLinks.length ?? 0,
    };
  });
  return { obligations, truncated: assignmentResult.truncated || contentResult.truncated };
}

// ---- Per-Campaign summary -------------------------------------------

// Pure, separately unit-testable: every derived field is a plain
// aggregation over the already-composed obligations list plus the
// already-fetched analyticsReadiness - no I/O of its own (the one
// `new Date()` call mirrors the rest of this codebase's own "server time
// at call time, never client-supplied" idiom - see e.g. campaign-
// service.ts's editCampaign - and is exercised deterministically in unit
// tests via obligations whose dueAt sits far in the past/future rather
// than an injected clock).
export function computeCampaignExecutionSummary(campaignRef: string, obligations: CampaignExecutionObligation[], analyticsReadiness: CampaignAnalyticsReadiness, truncated: boolean): CampaignExecutionSummary {
  const nowIso = new Date().toISOString();

  const deliveryState = { completed: 0, inProgress: 0, notStarted: 0 };
  for (const obligation of obligations) {
    deliveryState[classifyObligationDeliveryState(obligation)] += 1;
  }

  return {
    campaignRef,
    totalObligations: obligations.length,
    approvedCount: obligations.filter((o) => o.contentStatus === "APPROVED").length,
    distinctPartnerCount: new Set(obligations.map((o) => o.partnerRef)).size,
    overdueCount: obligations.filter((o) => isObligationOverdue(o, nowIso)).length,
    deliveryState,
    underReviewCount: obligations.filter((o) => o.contentStatus === "UNDER_REVIEW").length,
    revisionRequestedCount: obligations.filter((o) => o.contentStatus === "REVISION_REQUESTED").length,
    analyticsReadiness,
    // Never claimed complete over an incomplete obligation set.
    sourceLinksComplete: !truncated && obligations.length > 0 && obligations.every((o) => o.contentCurrentLinksCount >= 1),
    truncated,
  };
}

export async function getCampaignExecutionSummary(actor: ActorContext | null, campaignRef: unknown): Promise<CampaignsServiceResult<CampaignExecutionSummary>> {
  const gate = await requireCampaignsFeatureAccess(actor);
  if (!gate.ok) return campaignsUnauthorizedResult(gate.reason);

  // getCampaign reuses the exact same feature+scope check every other
  // Campaign read already goes through - never a second, parallel
  // authorization path.
  const campaignResult = await getCampaign(actor, campaignRef);
  if (!campaignResult.ok) return campaignResult;

  const grants = await getActorScopeGrants(actor!);
  const scope: ObligationScope = { actorUid: actor!.uid, grants, hasGlobal: hasGlobalScope(grants) };

  const [{ obligations, truncated }, analyticsReadiness] = await Promise.all([
    buildCampaignObligations(scope, campaignResult.data.campaignRef),
    evaluateCampaignAnalyticsReadiness(campaignResult.data.campaignRef),
  ]);

  return { ok: true, data: computeCampaignExecutionSummary(campaignResult.data.campaignRef, obligations, analyticsReadiness, truncated) };
}

// ---- Portfolio-wide overview -----------------------------------------

async function fetchActiveCampaignsBounded(actor: ActorContext): Promise<CampaignDto[]> {
  const campaigns: CampaignDto[] = [];
  let cursor: Parameters<typeof listCampaigns>[1]["cursor"];
  for (let page = 0; page < MAX_ACTIVE_CAMPAIGN_PAGES; page += 1) {
    const result = await listCampaigns(actor, { status: "ACTIVE", limit: ACTIVE_CAMPAIGN_PAGE_SIZE, cursor });
    if (!result.ok) break;
    campaigns.push(...result.data.campaigns);
    if (!result.data.nextCursor) break;
    cursor = result.data.nextCursor;
  }
  return campaigns;
}

type PerCampaignExecutionInput = {
  campaign: Pick<CampaignDto, "campaignRef" | "name" | "updatedAt">;
  obligations: CampaignExecutionObligation[];
  analyticsReadiness: CampaignAnalyticsReadiness;
  // See CampaignObligationsResult - this Campaign has more obligations than
  // were read, so `obligations` is only its first bounded slice.
  truncated: boolean;
};

// Pure aggregation over already-fetched per-Campaign data - independently
// unit-testable against synthetic fixtures, no I/O of its own (same "one
// new Date() at the top" idiom as computeCampaignExecutionSummary).
export function computeCampaignExecutionOverview(perCampaign: PerCampaignExecutionInput[]): CampaignExecutionOverview {
  const nowIso = new Date().toISOString();
  const allObligations = perCampaign.flatMap((p) => p.obligations);

  const totalObligations = allObligations.length;
  const approvedObligations = allObligations.filter((o) => o.contentStatus === "APPROVED").length;
  const overdueObligations = allObligations.filter((o) => isObligationOverdue(o, nowIso)).length;

  const deliveryState = { completed: 0, inProgress: 0, notStarted: 0 };
  for (const obligation of allObligations) {
    deliveryState[classifyObligationDeliveryState(obligation)] += 1;
  }

  // Campaigns with zero obligations are excluded from the row list itself
  // (a 0/0 ring would render a misleading percentage) - their signal is
  // carried instead by "Campaigns unstaffed" / "Campaigns without
  // assignments" below, never fabricated as a bar. A TRUNCATED Campaign is
  // never unstaffed (obligations may exist beyond the scan ceiling), so it
  // stays a row - flagged, so its count/percentage is not shown as exact.
  // Sorted by updatedAt
  // descending (most-recently-touched Campaign first), ties broken by
  // campaignRef ascending for full determinism - documented choice, never
  // random/insertion order.
  const perCampaignExecution = perCampaign
    .filter((p) => p.obligations.length > 0 || p.truncated)
    .map((p) => ({
      campaignRef: p.campaign.campaignRef,
      campaignName: p.campaign.name,
      approvedCount: p.obligations.filter((o) => o.contentStatus === "APPROVED").length,
      totalCount: p.obligations.length,
      truncated: p.truncated,
    }))
    .sort((a, b) => {
      const campaignA = perCampaign.find((p) => p.campaign.campaignRef === a.campaignRef)!.campaign;
      const campaignB = perCampaign.find((p) => p.campaign.campaignRef === b.campaignRef)!.campaign;
      if (campaignA.updatedAt !== campaignB.updatedAt) return campaignA.updatedAt < campaignB.updatedAt ? 1 : -1;
      return a.campaignRef < b.campaignRef ? -1 : a.campaignRef > b.campaignRef ? 1 : 0;
    })
    .slice(0, 4);

  const truncatedCampaignCount = perCampaign.filter((p) => p.truncated).length;
  const campaignsUnstaffedCount = perCampaign.filter((p) => p.obligations.length === 0 && !p.truncated).length;

  const anyHasLinkedSourceRecords = perCampaign.some((p) => p.analyticsReadiness.hasLinkedSourceRecords);
  const trackingConfiguredRow = {
    label: "Tracking configured",
    detail: anyHasLinkedSourceRecords ? "At least one active Campaign has linked Analytics data" : "No active Campaign has linked Analytics data yet",
    badge: anyHasLinkedSourceRecords ? "Current" : "Not started",
  };

  const sourceLinksCompleteOverall = totalObligations > 0 && allObligations.every((o) => o.contentCurrentLinksCount >= 1);
  const sourceLinksCompleteRow =
    truncatedCampaignCount > 0 && (totalObligations === 0 || sourceLinksCompleteOverall)
      ? // Step 12C.2: never claim completeness over an incomplete set.
        { label: "Source links complete", detail: "Only the first obligations per Campaign were checked; some Campaigns have more.", badge: "Partial" }
      : {
          label: "Source links complete",
          detail: totalObligations === 0 ? "No obligations yet" : sourceLinksCompleteOverall ? "Every obligation's Content thread has at least one submitted link" : "Some obligations are still missing a submitted link",
          badge: totalObligations === 0 ? "Review" : sourceLinksCompleteOverall ? "Current" : "Partial",
        };

  // The Analytics readiness helper (evaluateCampaignAnalyticsReadiness)
  // exposes hasLinkedSourceRecords/matchedCount/unmatchedCount/lastDataAt
  // only - nothing that maps cleanly to "eligible for reporting". Rather
  // than invent a formula, this row renders honestly Unavailable.
  const reportingEligibleRow = { label: "Reporting eligible", detail: "Not defined by the Analytics readiness data available today.", badge: "Unavailable" };

  const campaignsUnstaffedRow = {
    label: "Campaigns unstaffed",
    detail: campaignsUnstaffedCount > 0 ? `${campaignsUnstaffedCount} active Campaign${campaignsUnstaffedCount === 1 ? "" : "s"} with no execution obligations` : "Every active Campaign has at least one obligation",
    badge: campaignsUnstaffedCount > 0 ? "Review" : "Current",
  };

  return {
    activeCampaignCount: perCampaign.length,
    distinctAssignedPartnerCount: new Set(allObligations.map((o) => o.partnerRef)).size,
    totalObligations,
    approvedObligations,
    overdueObligations,
    perCampaignExecution,
    deliveryState,
    trackingReadiness: { trackingConfiguredRow, sourceLinksCompleteRow, reportingEligibleRow, campaignsUnstaffedRow },
    executionExceptions: {
      overdueContent: overdueObligations,
      awaitingReview: allObligations.filter((o) => o.contentStatus === "UNDER_REVIEW").length,
      changesRequested: allObligations.filter((o) => o.contentStatus === "REVISION_REQUESTED").length,
      campaignsWithoutAssignments: campaignsUnstaffedCount,
    },
    truncated: truncatedCampaignCount > 0,
    truncatedCampaignCount,
  };
}

export async function getCampaignExecutionOverview(actor: ActorContext | null): Promise<CampaignsServiceResult<CampaignExecutionOverview>> {
  const gate = await requireCampaignsFeatureAccess(actor);
  if (!gate.ok) return campaignsUnauthorizedResult(gate.reason);

  const activeCampaigns = await fetchActiveCampaignsBounded(actor!);
  const grants = await getActorScopeGrants(actor!);
  const scope: ObligationScope = { actorUid: actor!.uid, grants, hasGlobal: hasGlobalScope(grants) };

  const perCampaign: PerCampaignExecutionInput[] = await Promise.all(
    activeCampaigns.map(async (campaign) => {
      const [{ obligations, truncated }, analyticsReadiness] = await Promise.all([buildCampaignObligations(scope, campaign.campaignRef), evaluateCampaignAnalyticsReadiness(campaign.campaignRef)]);
      return { campaign, obligations, analyticsReadiness, truncated };
    }),
  );

  return { ok: true, data: computeCampaignExecutionOverview(perCampaign) };
}

// ---- Execution Exceptions categories (only non-zero, mirrors Analytics'
// own buildIngestionExceptionCategories discipline exactly - never padded
// to a fixed row count) --------------------------------------------------

// `count` is always the raw number; `countLabel` is what the Overview shows -
// a lower-bound "N+" for the three obligation-derived categories when any
// contributing Campaign is truncated (Step 12C.2), the plain number otherwise
// ("Campaigns without assignments" is exact even then).
export type ExecutionExceptionCategory = { title: string; detail: string; count: number; countLabel: string; href: string };

// Deep-link targets: neither /assignments nor /content genuinely supports
// a URL-driven status filter query param today (both filter via
// client-side React state only - confirmed against ContentWorkspace.tsx/
// AssignmentsWorkspace.tsx) - so Content-shaped exceptions link to the
// real, unfiltered /assignments workspace rather than inventing a filter
// param neither page would honor. Campaigns-without-assignments links to
// the real, unfiltered /campaigns route.
export function buildExecutionExceptionCategories(exceptions: CampaignExecutionOverview["executionExceptions"], truncated = false): ExecutionExceptionCategory[] {
  const label = (count: number, lowerBound: boolean) => (lowerBound ? `${count}+` : String(count));
  const rows: ExecutionExceptionCategory[] = [];
  if (exceptions.overdueContent > 0) rows.push({ title: "Overdue content", detail: "Resolve", count: exceptions.overdueContent, countLabel: label(exceptions.overdueContent, truncated), href: "/assignments" });
  if (exceptions.awaitingReview > 0) rows.push({ title: "Awaiting review", detail: "Review", count: exceptions.awaitingReview, countLabel: label(exceptions.awaitingReview, truncated), href: "/assignments" });
  if (exceptions.changesRequested > 0) rows.push({ title: "Changes requested", detail: "Follow up", count: exceptions.changesRequested, countLabel: label(exceptions.changesRequested, truncated), href: "/assignments" });
  if (exceptions.campaignsWithoutAssignments > 0) rows.push({ title: "Campaigns without assignments", detail: "Review", count: exceptions.campaignsWithoutAssignments, countLabel: String(exceptions.campaignsWithoutAssignments), href: "/campaigns" });
  return rows;
}
