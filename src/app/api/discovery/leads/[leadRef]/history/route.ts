import { getLeadHistory } from "@/server/discovery/lead-service";
import { resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

type RouteParams = { params: Promise<{ leadRef: string }> };

// GET /api/discovery/leads/[leadRef]/history?limit=&cursorCreatedAt=&cursorId=
export async function GET(request: Request, { params }: RouteParams) {
  const { leadRef } = await params;
  const actor = await resolveRequestActor();

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursorCreatedAt = url.searchParams.get("cursorCreatedAt");
  const cursorId = url.searchParams.get("cursorId");

  const input = {
    limit: limitParam ? Number(limitParam) : undefined,
    cursor: cursorCreatedAt && cursorId ? { createdAt: cursorCreatedAt, id: cursorId } : undefined,
  };

  const result = await getLeadHistory(actor, leadRef, input);
  return toDiscoveryHttpResponse(result);
}
