import { NextResponse } from "next/server";

import { unblockTask } from "@/server/operations";
import { newRequestId, parseJsonBody, resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

type RouteParams = { params: Promise<{ taskRef: string }> };

// POST /api/operations/tasks/[taskRef]/unblock {expectedDocVersion}
// BLOCKED -> IN_PROGRESS; needs complete_tasks.
export async function POST(request: Request, { params }: RouteParams) {
  const { taskRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await unblockTask(actor, { ...(body as object), taskRef }, newRequestId());
  return toOperationsHttpResponse(result);
}
