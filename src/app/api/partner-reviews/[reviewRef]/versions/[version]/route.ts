import { getPartnerReviewVersion } from "@/server/partner-reviews/partner-review-service";
import { resolveRequestActor, toPartnerReviewsHttpResponse } from "@/server/partner-reviews/http";

type RouteParams = { params: Promise<{ reviewRef: string; version: string }> };

// GET /api/partner-reviews/[reviewRef]/versions/[version]
export async function GET(_request: Request, { params }: RouteParams) {
  const { reviewRef, version } = await params;
  const actor = await resolveRequestActor();
  const result = await getPartnerReviewVersion(actor, reviewRef, version);
  return toPartnerReviewsHttpResponse(result);
}
