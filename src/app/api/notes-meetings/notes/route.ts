import { NextResponse } from "next/server";

import { createNote, listNotes } from "@/server/notes-meetings";
import { newRequestId, optionalIntegerParam, optionalStringParam, parseJsonBody, resolveRequestActor, toNotesMeetingsHttpResponse } from "@/server/notes-meetings/http";

// GET /api/notes-meetings/notes?ownerType=&ownerRef=&status=&authorUserRef=&limit=
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);
  const ownerType = optionalStringParam(searchParams, "ownerType");
  const ownerRef = optionalStringParam(searchParams, "ownerRef");
  const result = await listNotes(actor, { owner: { ownerType, ownerRef }, status: optionalStringParam(searchParams, "status"), authorUserRef: optionalStringParam(searchParams, "authorUserRef"), limit: optionalIntegerParam(searchParams, "limit") });
  return toNotesMeetingsHttpResponse(result);
}

// POST /api/notes-meetings/notes {owner:{ownerType,ownerRef}, body, visibility?}
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await createNote(actor, body, newRequestId());
  if (!result.ok) return toNotesMeetingsHttpResponse(result);
  return NextResponse.json(result.data, { status: 201 });
}
