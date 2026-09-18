import { getContentHistory } from "@/server/content/content-service";
import { resolveRequestActor, toContentHttpResponse } from "@/server/content/http";

type RouteParams = { params: Promise<{ contentRef: string }> };

// GET /api/content/[contentRef]/history?limit=&cursorCreatedAt=&cursorId=
export async function GET(request: Request, { params }: RouteParams) {
  const { contentRef } = await params;
  const actor = await resolveRequestActor();

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursorCreatedAt = url.searchParams.get("cursorCreatedAt");
  const cursorId = url.searchParams.get("cursorId");

  const input = {
    limit: limitParam ? Number(limitParam) : undefined,
    cursor: cursorCreatedAt && cursorId ? { createdAt: cursorCreatedAt, id: cursorId } : undefined,
  };

  const result = await getContentHistory(actor, contentRef, input);
  return toContentHttpResponse(result);
}
