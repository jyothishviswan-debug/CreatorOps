import { getPartnerReview } from "@/server/partner-reviews/partner-review-service";
import { resolveRequestActor, toPartnerReviewsHttpResponse } from "@/server/partner-reviews/http";

type RouteParams = { params: Promise<{ reviewRef: string }> };

// GET /api/partner-reviews/[reviewRef]?version= - head + version history +
// the selected version's evidence snapshot + derived freshness.
export async function GET(request: Request, { params }: RouteParams) {
  const { reviewRef } = await params;
  const actor = await resolveRequestActor();

  const versionParam = new URL(request.url).searchParams.get("version");
  const result = await getPartnerReview(actor, reviewRef, { version: versionParam === null ? undefined : Number(versionParam) });
  return toPartnerReviewsHttpResponse(result);
}
