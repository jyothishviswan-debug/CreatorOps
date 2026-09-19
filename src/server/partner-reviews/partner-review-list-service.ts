import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import type { PartnerReviewHeadDto } from "./client-dto";
import { toPartnerReviewHeadDtos } from "./client-dto";
import { listPartnerReviewHeadDocs, type PartnerReviewListCursor } from "./firestore";
import { loadAuthorizedPartner, requirePartnerReviewsFeatureAccess } from "./partner-reviews-gate";
import { derivePeriod } from "./period";
import { PARTNER_REVIEW_STATUSES, partnerReviewsInvalidInputResult, partnerReviewsUnauthorizedResult, type PartnerReviewsServiceResult } from "./types";

// Step 13A.1: the LIST-SAFE service boundary.
//
// This module serves head/list DTOs (PartnerReviewHeadDto) for a future
// /partner-reviews list / overview. It is deliberately isolated from the
// per-review services in partner-review-service.ts and MUST NEVER import or
// call the evidence collector (collectPartnerEvidence), the freshness
// evaluator, the source-access resolver or any upstream Assignment/
// Content/Analytics reader: a list of N reviews must cost O(page) head
// reads, never N full freshness recomputations. Freshness and the evidence
// snapshot are exposed only through the single-review detail / version /
// freshness services. partner-reviews-boundary.test.ts proves this (a static
// import-graph scan plus a runtime collector-invocation count).

export type ListPartnerReviewHeadsInput = {
  limit?: number;
  cursor?: PartnerReviewListCursor;
  partnerRef?: string;
  periodKey?: string;
  status?: string;
};

export async function listPartnerReviewHeads(actor: ActorContext | null, input: ListPartnerReviewHeadsInput): Promise<PartnerReviewsServiceResult<{ heads: PartnerReviewHeadDto[]; nextCursor: PartnerReviewListCursor | null }>> {
  const gate = await requirePartnerReviewsFeatureAccess(actor);
  if (!gate.ok) return partnerReviewsUnauthorizedResult(gate.reason);

  if (input.periodKey !== undefined && !derivePeriod(input.periodKey)) return partnerReviewsInvalidInputResult("periodKey must be a valid YYYY-MM month.");
  if (input.status !== undefined && !(PARTNER_REVIEW_STATUSES as readonly string[]).includes(input.status)) return partnerReviewsInvalidInputResult("Unknown status filter.");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) return partnerReviewsInvalidInputResult("limit must be a positive integer.");

  let partnerAuthorized = false;
  if (input.partnerRef !== undefined) {
    if (input.partnerRef.length === 0) return partnerReviewsInvalidInputResult("partnerRef must not be empty.");
    // Record Scope for a review is its Partner's scope: authorize the
    // (live) Partner once, then list that Partner's reviews directly. A
    // missing and an out-of-scope Partner are indistinguishable - both
    // simply yield an empty page, never revealing the Partner.
    const loaded = await loadAuthorizedPartner(actor!, input.partnerRef);
    if (!loaded.ok) return { ok: true, data: { heads: [], nextCursor: null } };
    partnerAuthorized = true;
  }

  const grants = await getActorScopeGrants(actor!);
  const page = await listPartnerReviewHeadDocs({
    limit: input.limit ?? 20,
    cursor: input.cursor,
    actorUid: actor!.uid,
    grants,
    hasGlobal: hasGlobalScope(grants),
    partnerRef: input.partnerRef,
    partnerAuthorized,
    periodKey: input.periodKey,
    status: input.status,
  });

  return { ok: true, data: { heads: await toPartnerReviewHeadDtos(page.heads), nextCursor: page.nextCursor } };
}
