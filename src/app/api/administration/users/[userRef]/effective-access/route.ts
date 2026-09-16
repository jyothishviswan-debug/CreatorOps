import { getEffectiveAccess } from "@/server/administration/effective-access-service";
import { resolveRequestActor, toHttpResponse } from "@/server/administration/http";

type RouteParams = { params: Promise<{ userRef: string }> };

// GET /api/administration/users/[userRef]/effective-access - the user's
// resolved feature/action/scope/sensitive-access summary, computed with
// the exact same shared primitives that enforce access everywhere else.
export async function GET(_request: Request, { params }: RouteParams) {
  const { userRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getEffectiveAccess(actor, userRef);
  return toHttpResponse(result);
}
