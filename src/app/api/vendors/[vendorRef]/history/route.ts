import { getVendorHistory } from "@/server/vendors/vendor-service";
import { resolveRequestActor, toVendorsHttpResponse } from "@/server/vendors/http";

type RouteParams = { params: Promise<{ vendorRef: string }> };

// GET /api/vendors/[vendorRef]/history?limit=&cursorCreatedAt=&cursorId=
export async function GET(request: Request, { params }: RouteParams) {
  const { vendorRef } = await params;
  const actor = await resolveRequestActor();

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursorCreatedAt = url.searchParams.get("cursorCreatedAt");
  const cursorId = url.searchParams.get("cursorId");

  const input = {
    limit: limitParam ? Number(limitParam) : undefined,
    cursor: cursorCreatedAt && cursorId ? { createdAt: cursorCreatedAt, id: cursorId } : undefined,
  };

  const result = await getVendorHistory(actor, vendorRef, input);
  return toVendorsHttpResponse(result);
}
