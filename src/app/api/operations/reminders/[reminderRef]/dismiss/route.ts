import { NextResponse } from "next/server";

import { dismissReminder } from "@/server/operations";
import { newRequestId, parseJsonBody, resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

type RouteParams = { params: Promise<{ reminderRef: string }> };

// POST /api/operations/reminders/[reminderRef]/dismiss {expectedDocVersion}
export async function POST(request: Request, { params }: RouteParams) {
  const { reminderRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await dismissReminder(actor, { ...(body as object), reminderRef }, newRequestId());
  return toOperationsHttpResponse(result);
}
