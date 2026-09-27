import { NextResponse } from "next/server";

import { addAttachment, listAttachments, readAttachmentUploadRequest } from "@/server/notes-meetings";
import { newRequestId, resolveRequestActor, toNotesMeetingsHttpResponse } from "@/server/notes-meetings/http";

type RouteParams = { params: Promise<{ meetingRef: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { meetingRef } = await params;
  const actor = await resolveRequestActor();
  const result = await listAttachments(actor, { kind: "MEETING", ref: meetingRef });
  return toNotesMeetingsHttpResponse(result);
}

export async function POST(request: Request, { params }: RouteParams) {
  const { meetingRef } = await params;
  const actor = await resolveRequestActor();
  const read = await readAttachmentUploadRequest(request);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status });
  const result = await addAttachment(actor, { parent: { kind: "MEETING", ref: meetingRef }, fileName: read.input.fileName, mimeType: read.input.mimeType, bytes: read.input.bytes }, newRequestId());
  if (!result.ok) return toNotesMeetingsHttpResponse(result);
  return NextResponse.json(result.data, { status: 201 });
}
