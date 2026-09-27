import { NextResponse } from "next/server";

import { createMeeting, listMeetings } from "@/server/notes-meetings";
import { newRequestId, optionalIntegerParam, optionalStringParam, parseJsonBody, resolveRequestActor, toNotesMeetingsHttpResponse } from "@/server/notes-meetings/http";

// GET /api/notes-meetings/meetings?ownerType=&ownerRef=&status=&limit=
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);
  const result = await listMeetings(actor, { owner: { ownerType: optionalStringParam(searchParams, "ownerType"), ownerRef: optionalStringParam(searchParams, "ownerRef") }, status: optionalStringParam(searchParams, "status"), limit: optionalIntegerParam(searchParams, "limit") });
  return toNotesMeetingsHttpResponse(result);
}

// POST /api/notes-meetings/meetings {owner, title, meetingAt, participants?, agenda?, summary?, decisions?, visibility?}
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await createMeeting(actor, body, newRequestId());
  if (!result.ok) return toNotesMeetingsHttpResponse(result);
  return NextResponse.json(result.data, { status: 201 });
}
