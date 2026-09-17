import { getCampaignHistory } from "@/server/campaigns/campaign-service";
import { resolveRequestActor, toCampaignsHttpResponse } from "@/server/campaigns/http";

type RouteParams = { params: Promise<{ campaignRef: string }> };

// GET /api/campaigns/[campaignRef]/history?limit=&cursorCreatedAt=&cursorId=
export async function GET(request: Request, { params }: RouteParams) {
  const { campaignRef } = await params;
  const actor = await resolveRequestActor();

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursorCreatedAt = url.searchParams.get("cursorCreatedAt");
  const cursorId = url.searchParams.get("cursorId");

  const input = {
    limit: limitParam ? Number(limitParam) : undefined,
    cursor: cursorCreatedAt && cursorId ? { createdAt: cursorCreatedAt, id: cursorId } : undefined,
  };

  const result = await getCampaignHistory(actor, campaignRef, input);
  return toCampaignsHttpResponse(result);
}
