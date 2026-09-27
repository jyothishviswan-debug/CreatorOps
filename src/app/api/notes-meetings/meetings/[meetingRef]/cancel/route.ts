import { NextResponse } from "next/server";

import { cancelMeeting } from "@/server/notes-meetings";
import { newRequestId, parseJsonBody, resolveRequestActor, toNotesMeetingsHttpResponse } from "@/server/notes-meetings/http";

type RouteParams = { params: Promise<{ meetingRef: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const { meetingRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined || typeof body !== "object" || body === null) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await cancelMeeting(actor, { ...body, meetingRef }, newRequestId());
  return toNotesMeetingsHttpResponse(result);
}
