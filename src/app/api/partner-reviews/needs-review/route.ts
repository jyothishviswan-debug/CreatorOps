import { deriveNeedsReview } from "@/server/partner-reviews/partner-review-service";
import { resolveRequestActor, toPartnerReviewsHttpResponse } from "@/server/partner-reviews/http";

// GET /api/partner-reviews/needs-review?partnerRef=&periodKey= - the
// derived (never persisted) Needs Review signal for one Partner + month.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);
  const result = await deriveNeedsReview(actor, { partnerRef: url.searchParams.get("partnerRef") ?? "", periodKey: url.searchParams.get("periodKey") ?? "" });
  return toPartnerReviewsHttpResponse(result);
}
