import { NextResponse } from "next/server";

import { reopenTask } from "@/server/operations";
import { newRequestId, parseJsonBody, resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

type RouteParams = { params: Promise<{ taskRef: string }> };

// POST /api/operations/tasks/[taskRef]/reopen {expectedDocVersion, reason}
// DONE|CANCELLED -> OPEN; needs complete_tasks. Section 5's own explicit-action requirement.
export async function POST(request: Request, { params }: RouteParams) {
  const { taskRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await reopenTask(actor, { ...(body as object), taskRef }, newRequestId());
  return toOperationsHttpResponse(result);
}
