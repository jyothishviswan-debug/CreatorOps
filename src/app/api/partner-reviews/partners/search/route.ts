import { searchReviewPartners } from "@/server/partner-reviews/partner-review-workspace-service";
import { resolveRequestActor, toPartnerReviewsHttpResponse } from "@/server/partner-reviews/http";
import { parseSearchQuery } from "@/server/partner-reviews/ui-params";

// GET /api/partner-reviews/partners/search?q= - the Workspace Partner filter's bounded, scope-first
// Partner search (display-name prefix over the actor's own authorized Partners). Read-only; results
// are display identity only.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const q = parseSearchQuery(new URL(request.url).searchParams.get("q"));
  const result = await searchReviewPartners(actor, { q });
  return toPartnerReviewsHttpResponse(result);
}
