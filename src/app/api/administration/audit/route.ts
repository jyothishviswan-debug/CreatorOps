import { listAuditEventsForReview } from "@/server/administration/audit-service";
import { resolveRequestActor, toHttpResponse } from "@/server/administration/http";

// GET /api/administration/audit?limit=&cursorCreatedAt=&cursorRequestId=
export async function GET(request: Request) {
  const actor = await resolveRequestActor();

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursorCreatedAt = url.searchParams.get("cursorCreatedAt");
  const cursorRequestId = url.searchParams.get("cursorRequestId");

  const input = {
    limit: limitParam ? Number(limitParam) : undefined,
    cursor: cursorCreatedAt && cursorRequestId ? { createdAt: cursorCreatedAt, requestId: cursorRequestId } : undefined,
  };

  const result = await listAuditEventsForReview(actor, input);
  return toHttpResponse(result);
}
