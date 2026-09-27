import { NextResponse } from "next/server";

import { createActionItem, listActionItems } from "@/server/notes-meetings";
import { newRequestId, parseJsonBody, resolveRequestActor, toNotesMeetingsHttpResponse } from "@/server/notes-meetings/http";

type RouteParams = { params: Promise<{ meetingRef: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { meetingRef } = await params;
  const actor = await resolveRequestActor();
  const result = await listActionItems(actor, meetingRef);
  return toNotesMeetingsHttpResponse(result);
}

// POST {expectedDocVersion, text, assigneeUserRef?, dueAt?}
export async function POST(request: Request, { params }: RouteParams) {
  const { meetingRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined || typeof body !== "object" || body === null) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await createActionItem(actor, { ...body, meetingRef }, newRequestId());
  if (!result.ok) return toNotesMeetingsHttpResponse(result);
  return NextResponse.json(result.data, { status: 201 });
}
