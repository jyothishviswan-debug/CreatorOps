import { getAssignmentHistory } from "@/server/assignments/assignment-service";
import { resolveRequestActor, toAssignmentsHttpResponse } from "@/server/assignments/http";

type RouteParams = { params: Promise<{ assignmentRef: string }> };

// GET /api/assignments/[assignmentRef]/history?limit=&cursorCreatedAt=&cursorId=
export async function GET(request: Request, { params }: RouteParams) {
  const { assignmentRef } = await params;
  const actor = await resolveRequestActor();

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursorCreatedAt = url.searchParams.get("cursorCreatedAt");
  const cursorId = url.searchParams.get("cursorId");

  const input = {
    limit: limitParam ? Number(limitParam) : undefined,
    cursor: cursorCreatedAt && cursorId ? { createdAt: cursorCreatedAt, id: cursorId } : undefined,
  };

  const result = await getAssignmentHistory(actor, assignmentRef, input);
  return toAssignmentsHttpResponse(result);
}
