import { searchPartnerOwnerCandidates } from "@/server/partners/user-picker";
import { resolveRequestActor, toPartnersHttpResponse } from "@/server/partners/http";

// GET /api/partners/users/search?emailPrefix=
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);
  const emailPrefix = url.searchParams.get("emailPrefix") ?? "";

  const result = await searchPartnerOwnerCandidates(actor, { emailPrefix });
  return toPartnersHttpResponse(result);
}
