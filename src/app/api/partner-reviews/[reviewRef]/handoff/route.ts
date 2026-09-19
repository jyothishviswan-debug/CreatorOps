import { getFinalizedReviewHandoff } from "@/server/partner-reviews/finalized-review-handoff-service";
import { resolveRequestActor, toPartnerReviewsHttpResponse } from "@/server/partner-reviews/http";

type RouteParams = { params: Promise<{ reviewRef: string }> };

// GET /api/partner-reviews/[reviewRef]/handoff?version= - the READ-ONLY
// finalized-review handoff (default: the current finalized version). Counts
// and results only: no source-record identifiers. A superseded version stays
// addressable and reports it is stale. Same auth chain as every read here.
export async function GET(request: Request, { params }: RouteParams) {
  const { reviewRef } = await params;
  const actor = await resolveRequestActor();

  const versionParam = new URL(request.url).searchParams.get("version");
  const result = await getFinalizedReviewHandoff(actor, reviewRef, versionParam === null ? undefined : versionParam);
  return toPartnerReviewsHttpResponse(result);
}
