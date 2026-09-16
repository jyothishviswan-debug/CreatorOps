import { getLeadReadiness } from "@/server/discovery/conversion-service";
import { resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

type RouteParams = { params: Promise<{ leadRef: string }> };

// GET /api/discovery/leads/[leadRef]/readiness - derived, recomputed on
// every call from the canonical Lead/evidence sources. Never a
// manually-writable checkbox.
export async function GET(_request: Request, { params }: RouteParams) {
  const { leadRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getLeadReadiness(actor, leadRef);
  return toDiscoveryHttpResponse(result);
}
