import { getCampaignReadiness } from "@/server/campaigns/campaign-service";
import { resolveRequestActor, toCampaignsHttpResponse } from "@/server/campaigns/http";

type RouteParams = { params: Promise<{ campaignRef: string }> };

// GET /api/campaigns/[campaignRef]/readiness - always recomputed live,
// never cached, never a stored checkbox (see readiness.ts's own comment).
export async function GET(_request: Request, { params }: RouteParams) {
  const { campaignRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getCampaignReadiness(actor, campaignRef);
  return toCampaignsHttpResponse(result);
}
