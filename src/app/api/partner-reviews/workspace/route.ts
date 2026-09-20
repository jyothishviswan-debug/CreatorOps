import { getPartnerReviewsWorkspace } from "@/server/partner-reviews/partner-review-workspace-service";
import { resolveRequestActor, toPartnerReviewsHttpResponse } from "@/server/partner-reviews/http";
import { parseFilterParam, parseLimitParam, parseMonthParam, parsePartnerRefParam, parseRegionParam, parseSignalParam } from "@/server/partner-reviews/ui-params";

// GET /api/partner-reviews/workspace?filter=&month=&signal=&partnerRef=&region=&cursor=&limit= -
// one bounded page of the Partner Reviews Workspace (the "Load more" call). The very same trusted
// service renders the page's first page; `cursor` is an opaque server-issued token (a malformed one
// is dropped), every other value is re-validated server-side. Read-only.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);
  const params = url.searchParams;

  const result = await getPartnerReviewsWorkspace(actor, {
    month: parseMonthParam(params.get("month")),
    filter: parseFilterParam(params.get("filter")),
    signal: parseSignalParam(params.get("signal")),
    partnerRef: parsePartnerRefParam(params.get("partnerRef")),
    region: parseRegionParam(params.getAll("region")),
    cursor: params.get("cursor") ?? undefined,
    limit: parseLimitParam(params.get("limit")),
  });
  return toPartnerReviewsHttpResponse(result);
}
