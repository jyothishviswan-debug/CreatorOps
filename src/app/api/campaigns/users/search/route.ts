import { searchCampaignOwnerCandidates } from "@/server/campaigns/user-picker";
import { resolveRequestActor, toCampaignsHttpResponse } from "@/server/campaigns/http";

// GET /api/campaigns/users/search?emailPrefix=
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);
  const emailPrefix = url.searchParams.get("emailPrefix") ?? "";

  const result = await searchCampaignOwnerCandidates(actor, { emailPrefix });
  return toCampaignsHttpResponse(result);
}
