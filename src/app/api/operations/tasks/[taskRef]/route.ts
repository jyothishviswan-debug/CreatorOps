import { getTask } from "@/server/operations";
import { resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

type RouteParams = { params: Promise<{ taskRef: string }> };

// GET /api/operations/tasks/[taskRef]
export async function GET(_request: Request, { params }: RouteParams) {
  const { taskRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getTask(actor, taskRef);
  return toOperationsHttpResponse(result);
}
