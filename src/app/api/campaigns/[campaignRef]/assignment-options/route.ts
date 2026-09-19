import { getAssignmentCreateOptions } from "@/server/campaigns/assignment-options-service";
import { resolveRequestActor, toCampaignsHttpResponse } from "@/server/campaigns/http";

type RouteParams = { params: Promise<{ campaignRef: string }> };

// GET /api/campaigns/[campaignRef]/assignment-options?q=<name prefix> |
// ?partnerRef=<ref> - the narrow, trusted, bounded read behind the Campaign
// Detail "Create Assignment" dialog. The Campaign is fixed by the URL and
// reloaded/authorized server-side on every call; `q` searches ACTIVE
// Partners (max 10), `partnerRef` returns that Partner's own selectable
// Partner Accounts plus any existing (Campaign, Partner) Assignment.
export async function GET(request: Request, { params }: RouteParams) {
  const { campaignRef } = await params;
  const actor = await resolveRequestActor();
  const url = new URL(request.url);
  const result = await getAssignmentCreateOptions(actor, campaignRef, {
    q: url.searchParams.get("q") ?? undefined,
    partnerRef: url.searchParams.get("partnerRef") ?? undefined,
  });
  return toCampaignsHttpResponse(result);
}
