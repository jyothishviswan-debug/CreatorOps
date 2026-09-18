import { searchAnalyticsPartnerAccountCandidates } from "@/server/analytics/partner-account-candidates";
import { resolveRequestActor, toAnalyticsHttpResponse } from "@/server/analytics/http";

// GET /api/analytics/partner-accounts/search - the one new, minimal,
// bounded/scoped/authorized endpoint this step adds (see
// partner-account-candidates.ts's own header comment for why: no
// existing cross-partner Partner Account search endpoint was found
// anywhere in this codebase). Used only by the channel-record match
// correction dialog.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);

  const query = url.searchParams.get("query") ?? undefined;
  const platform = url.searchParams.get("platform") ?? undefined;
  const limitParam = url.searchParams.get("limit");

  const result = await searchAnalyticsPartnerAccountCandidates(actor, { query, platform, limit: limitParam ? Number(limitParam) : undefined });
  return toAnalyticsHttpResponse(result);
}
