import { NextResponse } from "next/server";

import { reassignTask } from "@/server/operations";
import { newRequestId, parseJsonBody, resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

type RouteParams = { params: Promise<{ taskRef: string }> };

// POST /api/operations/tasks/[taskRef]/reassign {expectedDocVersion, assigneeUserRef, reason}
// Changes the primary assignee; needs assign_tasks (distinct from manage_tasks/complete_tasks). The
// new assignee must be admitted/active.
export async function POST(request: Request, { params }: RouteParams) {
  const { taskRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await reassignTask(actor, { ...(body as object), taskRef }, newRequestId());
  return toOperationsHttpResponse(result);
}
