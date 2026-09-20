import { resolveRequestActor, toAnalyticsHttpResponse } from "@/server/analytics/http";
import { searchWorkspacePartners } from "@/server/analytics/partners-workspace-service";

// GET /api/analytics/partners/search?q=&targetAudience=&region=&limit= - the
// Partners Analytics selector's bounded, scope-first Partner search (see
// searchWorkspacePartners). Analytics explore gate + the accepted Partners list
// scope, so an unauthenticated caller gets 401 and one without the explicit
// Analytics/Partners grants 403; results are safe display identity only.
// `targetAudience` and `region` may repeat; every value is validated server-side.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);

  const result = await searchWorkspacePartners(actor, {
    q: url.searchParams.get("q") ?? undefined,
    targetAudience: url.searchParams.getAll("targetAudience"),
    region: url.searchParams.getAll("region"),
    limit: url.searchParams.get("limit") ?? undefined,
  });
  return toAnalyticsHttpResponse(result);
}
