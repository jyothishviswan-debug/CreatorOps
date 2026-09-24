import { listTaskEvents } from "@/server/operations";
import { optionalIntegerParam, resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

type RouteParams = { params: Promise<{ taskRef: string }> };

// GET /api/operations/tasks/[taskRef]/events?limit=
// Bounded, newest-first page of this Task's audit history.
export async function GET(request: Request, { params }: RouteParams) {
  const { taskRef } = await params;
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);
  const result = await listTaskEvents(actor, taskRef, optionalIntegerParam(searchParams, "limit"));
  return toOperationsHttpResponse(result);
}
