// Step 12C.1: the trusted, read-only Campaign Detail "Downstream
// availability" summary - the ONE server-derived DTO behind the existing
// Assignments/Content/Analytics cards on Campaign Detail's Overview tab.
// Purely additive, never mutates anything, never imports anything
// Finance-shaped. Composes ONLY already-scoped reads
// (listAssignmentDocs/listContentDocs/evaluateCampaignAnalyticsReadiness)
// after Campaign Detail's own getCampaign gate - the same
// "join other domains' own canonical data via campaignRef/assignmentRef"
// discipline as execution-integration-service.ts, reusing its documented
// MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY bound.
//
// Definitions (identical to Step 12C's accepted semantics):
//  - "Assignments" = Campaign-linked Assignments excluding CANCELLED. DRAFT
//    IS included - the Detail card is a linked-records summary (a
//    just-created Draft must show), unlike Overview's obligation count
//    which counts issued work only. The Draft/issued breakdown makes the
//    difference explicit on the card.
//  - "Partners" = distinct partnerRef across those Assignments.
//  - Content counts = ONE canonical thread per (non-cancelled) Assignment,
//    by canonical thread status (APPROVED / UNDER_REVIEW / REVISION_REQUESTED).
//  - Analytics = evaluateCampaignAnalyticsReadiness, verbatim.
import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";

import { requireAnalyticsExploreAccess } from "@/server/analytics/analytics-gate";
import { evaluateCampaignAnalyticsReadiness, type CampaignAnalyticsReadiness } from "@/server/analytics/campaign-readiness";
import { isCampaignStatusAllowingAssignmentCreation } from "@/server/assignments/create-eligibility";
import { requireAssignmentsAccess, requireAssignmentsFeatureAccess } from "@/server/assignments/assignments-gate";
import { listAssignmentDocs, MAX_ASSIGNMENT_PAGE_SIZE } from "@/server/assignments/firestore";
import type { AssignmentStatus } from "@/server/assignments/types";
import { requireContentFeatureAccess } from "@/server/content/content-gate";
import { listContentDocs, MAX_CONTENT_PAGE_SIZE } from "@/server/content/firestore";
import type { ContentStatus } from "@/server/content/types";

import { getCampaign } from "./campaign-service";
import { MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY } from "./execution-integration-service";
import type { CampaignsServiceResult, CampaignStatus } from "./types";

// Assignments whose status makes them "issued" work (same set as
// EXECUTION_OBLIGATION_ASSIGNMENT_STATUSES; restated as the DRAFT-vs-issued
// split this card needs).
const ISSUED_ASSIGNMENT_STATUSES: ReadonlySet<AssignmentStatus> = new Set(["ASSIGNED", "ACCEPTED", "IN_PROGRESS", "COMPLETED"]);

export type DownstreamAssignmentsSection =
  | { available: true; total: number; draftCount: number; issuedCount: number; distinctPartnerCount: number; truncated: boolean }
  | { available: false };

export type DownstreamContentSection =
  | { available: true; approvedCount: number; underReviewCount: number; revisionRequestedCount: number; truncated: boolean }
  | { available: false };

export type DownstreamAnalyticsSection = ({ available: true } & CampaignAnalyticsReadiness) | { available: false };

// Everything on this DTO is a count, a boolean or a timestamp - no raw
// refs, no Partner/Account internals, no Finance anything.
export type CampaignDownstreamSummaryDto = {
  assignments: DownstreamAssignmentsSection;
  content: DownstreamContentSection;
  analytics: DownstreamAnalyticsSection;
  // The server's own decision (Campaign lifecycle PLANNED/ACTIVE AND the
  // actor holds assignments.create) - the client never derives this.
  canCreateAssignment: boolean;
};

// ---- Pure aggregation (unit-tested; no I/O) ------------------------------

export type DownstreamAssignmentInput = { assignmentRef: string; partnerRef: string; status: AssignmentStatus };
export type DownstreamContentInput = { assignmentRef: string; status: ContentStatus };

export type DownstreamAggregate = {
  total: number;
  draftCount: number;
  issuedCount: number;
  distinctPartnerCount: number;
  approvedCount: number;
  underReviewCount: number;
  revisionRequestedCount: number;
};

// `assignments` is the actor-visible, bounded, deterministically-ordered
// list. CANCELLED Assignments are dropped first; Content threads are then
// counted only when their Assignment survived that filter, and at most ONE
// thread per Assignment counts (the first in the supplied order - Content's
// own uniqueness claim makes a second one impossible in practice, this is
// belt and braces so a duplicate could never double-count).
export function aggregateDownstream(assignments: readonly DownstreamAssignmentInput[], contentThreads: readonly DownstreamContentInput[]): DownstreamAggregate {
  const live = assignments.filter((a) => a.status !== "CANCELLED");
  const liveRefs = new Set(live.map((a) => a.assignmentRef));

  const canonicalThreadByAssignment = new Map<string, DownstreamContentInput>();
  for (const thread of contentThreads) {
    if (!liveRefs.has(thread.assignmentRef)) continue;
    if (!canonicalThreadByAssignment.has(thread.assignmentRef)) canonicalThreadByAssignment.set(thread.assignmentRef, thread);
  }
  const threads = [...canonicalThreadByAssignment.values()];

  return {
    total: live.length,
    draftCount: live.filter((a) => a.status === "DRAFT").length,
    issuedCount: live.filter((a) => ISSUED_ASSIGNMENT_STATUSES.has(a.status)).length,
    distinctPartnerCount: new Set(live.map((a) => a.partnerRef)).size,
    approvedCount: threads.filter((t) => t.status === "APPROVED").length,
    underReviewCount: threads.filter((t) => t.status === "UNDER_REVIEW").length,
    revisionRequestedCount: threads.filter((t) => t.status === "REVISION_REQUESTED").length,
  };
}

// The server-side create-action visibility rule, kept pure so it is
// exactly unit-testable: lifecycle PLANNED/ACTIVE AND the actor's own
// assignments.create grant. Campaign scope is already guaranteed by the
// getCampaign call that precedes it.
export function computeCanCreateAssignment(campaignStatus: CampaignStatus, actorMayCreateAssignments: boolean): boolean {
  return actorMayCreateAssignments && isCampaignStatusAllowingAssignmentCreation(campaignStatus);
}

// ---- Bounded, scope-constrained fetch ----------------------------------

// listAssignmentDocs/listContentDocs cap a single page at 100, so the
// documented 200-per-Campaign bound is reached by following the cursor at
// most MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY / pageCap times - never an
// unbounded loop. `truncated` is true only when a further page genuinely
// remains after the bound.
async function fetchBounded<T>(pageCap: number, fetchPage: (limit: number, cursor: unknown) => Promise<{ items: T[]; nextCursor: unknown | null }>): Promise<{ items: T[]; truncated: boolean }> {
  const maxPages = Math.ceil(MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY / pageCap);
  const items: T[] = [];
  let cursor: unknown = undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(Math.min(pageCap, MAX_OBLIGATIONS_PER_CAMPAIGN_QUERY - items.length), cursor);
    items.push(...result.items);
    if (!result.nextCursor) return { items, truncated: false };
    cursor = result.nextCursor;
  }
  return { items, truncated: true };
}

export async function getCampaignDownstreamSummary(actor: ActorContext | null, campaignRef: unknown): Promise<CampaignsServiceResult<CampaignDownstreamSummaryDto>> {
  // getCampaign is the exact same feature + Record Scope gate every other
  // Campaign read goes through - never a second, parallel authorization
  // path. Everything below only ever runs for a Campaign the actor may
  // already see.
  const campaignResult = await getCampaign(actor, campaignRef);
  if (!campaignResult.ok) return campaignResult;
  const campaign = campaignResult.data;

  const [assignmentsFeature, contentFeature, analyticsExplore, createGrant] = await Promise.all([
    requireAssignmentsFeatureAccess(actor),
    requireContentFeatureAccess(actor),
    requireAnalyticsExploreAccess(actor),
    requireAssignmentsAccess(actor, "create"),
  ]);
  const assignmentsAvailable = assignmentsFeature.ok;
  const contentAvailable = contentFeature.ok;
  const analyticsAvailable = analyticsExplore.ok;

  const grants = await getActorScopeGrants(actor!);
  const scope = { actorUid: actor!.uid, grants, hasGlobal: hasGlobalScope(grants) };

  // Content counting needs the (actor-scoped) Assignment list to know which
  // threads belong to a non-cancelled Assignment - so it is fetched when
  // EITHER section is available, but only ever EXPOSED as an aggregate for
  // a section the actor is entitled to.
  let assignmentList: { items: DownstreamAssignmentInput[]; truncated: boolean } = { items: [], truncated: false };
  let contentList: { items: DownstreamContentInput[]; truncated: boolean } = { items: [], truncated: false };

  if (assignmentsAvailable || contentAvailable) {
    assignmentList = await fetchBounded(MAX_ASSIGNMENT_PAGE_SIZE, async (limit, cursor) => {
      const page = await listAssignmentDocs({ ...scope, campaignRef: campaign.campaignRef, limit, cursor: cursor as Parameters<typeof listAssignmentDocs>[0]["cursor"] });
      return { items: page.assignments.map((a) => ({ assignmentRef: a.assignmentRef, partnerRef: a.partnerRef, status: a.status })), nextCursor: page.nextCursor };
    });
  }
  if (contentAvailable) {
    contentList = await fetchBounded(MAX_CONTENT_PAGE_SIZE, async (limit, cursor) => {
      const page = await listContentDocs({ ...scope, campaignRef: campaign.campaignRef, limit, cursor: cursor as Parameters<typeof listContentDocs>[0]["cursor"] });
      return { items: page.content.map((c) => ({ assignmentRef: c.assignmentRef, status: c.status })), nextCursor: page.nextCursor };
    });
  }

  const aggregate = aggregateDownstream(assignmentList.items, contentList.items);
  const analyticsReadiness = analyticsAvailable ? await evaluateCampaignAnalyticsReadiness(campaign.campaignRef) : null;

  return {
    ok: true,
    data: {
      assignments: assignmentsAvailable
        ? {
            available: true,
            total: aggregate.total,
            draftCount: aggregate.draftCount,
            issuedCount: aggregate.issuedCount,
            distinctPartnerCount: aggregate.distinctPartnerCount,
            truncated: assignmentList.truncated,
          }
        : { available: false },
      content: contentAvailable
        ? {
            available: true,
            approvedCount: aggregate.approvedCount,
            underReviewCount: aggregate.underReviewCount,
            revisionRequestedCount: aggregate.revisionRequestedCount,
            // A Content bound hit, OR an Assignment bound hit (threads of
            // Assignments past the bound are not counted), both mean the
            // Content numbers are a lower bound.
            truncated: contentList.truncated || assignmentList.truncated,
          }
        : { available: false },
      analytics: analyticsReadiness ? { available: true, ...analyticsReadiness } : { available: false },
      canCreateAssignment: computeCanCreateAssignment(campaign.status, createGrant.ok),
    },
  };
}
