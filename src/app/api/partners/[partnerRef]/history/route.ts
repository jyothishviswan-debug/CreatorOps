import { getPartnerHistory } from "@/server/partners/partner-service";
import { resolveRequestActor, toPartnersHttpResponse } from "@/server/partners/http";

type RouteParams = { params: Promise<{ partnerRef: string }> };

// GET /api/partners/[partnerRef]/history?limit=&cursorCreatedAt=&cursorId=
export async function GET(request: Request, { params }: RouteParams) {
  const { partnerRef } = await params;
  const actor = await resolveRequestActor();

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursorCreatedAt = url.searchParams.get("cursorCreatedAt");
  const cursorId = url.searchParams.get("cursorId");

  const input = {
    limit: limitParam ? Number(limitParam) : undefined,
    cursor: cursorCreatedAt && cursorId ? { createdAt: cursorCreatedAt, id: cursorId } : undefined,
  };

  const result = await getPartnerHistory(actor, partnerRef, input);
  return toPartnersHttpResponse(result);
}
