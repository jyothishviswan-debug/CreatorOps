import { getCampaignDownstreamSummary } from "@/server/campaigns/detail-downstream-service";
import { resolveRequestActor, toCampaignsHttpResponse } from "@/server/campaigns/http";

type RouteParams = { params: Promise<{ campaignRef: string }> };

// GET /api/campaigns/[campaignRef]/downstream - the trusted, read-only,
// bounded Assignments/Content/Analytics summary behind Campaign Detail's
// "Downstream availability" cards. Always recomputed live, never cached.
export async function GET(_request: Request, { params }: RouteParams) {
  const { campaignRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getCampaignDownstreamSummary(actor, campaignRef);
  return toCampaignsHttpResponse(result);
}
