import { NextResponse } from "next/server";

import { promoteActionItem } from "@/server/notes-meetings";
import { newRequestId, parseJsonBody, resolveRequestActor, toNotesMeetingsHttpResponse } from "@/server/notes-meetings/http";

type RouteParams = { params: Promise<{ actionItemRef: string }> };

// POST {assigneeUserRef?, priority?} - explicit, permission-gated (promote_action_item), idempotent
// (spec section 9/11). A retry/double-click always converges on the same Task.
export async function POST(request: Request, { params }: RouteParams) {
  const { actionItemRef } = await params;
  const actor = await resolveRequestActor();
  const body = (await parseJsonBody(request)) ?? {};
  if (typeof body !== "object" || body === null) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await promoteActionItem(actor, { ...body, actionItemRef }, newRequestId());
  return toNotesMeetingsHttpResponse(result);
}
