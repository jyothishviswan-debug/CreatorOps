import { searchManagerCandidates } from "@/server/discovery/user-picker";
import { resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

// GET /api/discovery/users/search?emailPrefix=
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);
  const emailPrefix = url.searchParams.get("emailPrefix") ?? "";

  const result = await searchManagerCandidates(actor, { emailPrefix });
  return toDiscoveryHttpResponse(result);
}
