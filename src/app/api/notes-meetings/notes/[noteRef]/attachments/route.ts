import { NextResponse } from "next/server";

import { addAttachment, listAttachments, readAttachmentUploadRequest } from "@/server/notes-meetings";
import { newRequestId, resolveRequestActor, toNotesMeetingsHttpResponse } from "@/server/notes-meetings/http";

type RouteParams = { params: Promise<{ noteRef: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { noteRef } = await params;
  const actor = await resolveRequestActor();
  const result = await listAttachments(actor, { kind: "NOTE", ref: noteRef });
  return toNotesMeetingsHttpResponse(result);
}

// POST /api/notes-meetings/notes/[noteRef]/attachments - multipart/form-data, field "file".
export async function POST(request: Request, { params }: RouteParams) {
  const { noteRef } = await params;
  const actor = await resolveRequestActor();
  const read = await readAttachmentUploadRequest(request);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status });
  const result = await addAttachment(actor, { parent: { kind: "NOTE", ref: noteRef }, fileName: read.input.fileName, mimeType: read.input.mimeType, bytes: read.input.bytes }, newRequestId());
  if (!result.ok) return toNotesMeetingsHttpResponse(result);
  return NextResponse.json(result.data, { status: 201 });
}
