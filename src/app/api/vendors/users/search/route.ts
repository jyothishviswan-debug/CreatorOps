import { searchVendorOwnerCandidates } from "@/server/vendors/user-picker";
import { resolveRequestActor, toVendorsHttpResponse } from "@/server/vendors/http";

// GET /api/vendors/users/search?emailPrefix=
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);
  const emailPrefix = url.searchParams.get("emailPrefix") ?? "";

  const result = await searchVendorOwnerCandidates(actor, { emailPrefix });
  return toVendorsHttpResponse(result);
}
