import { NextResponse } from "next/server";

import { getAttachmentBytes } from "@/server/notes-meetings";
import { resolveRequestActor } from "@/server/notes-meetings/http";

type RouteParams = { params: Promise<{ attachmentRef: string }> };

// GET /api/notes-meetings/attachments/[attachmentRef] - re-authorized bytes-on-demand delivery
// (spec section 13: no public Storage URL, no raw object path in ordinary UI - this route is the
// only path any attachment's bytes ever reach the browser through).
export async function GET(_request: Request, { params }: RouteParams) {
  const { attachmentRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getAttachmentBytes(actor, attachmentRef);
  if (!result.ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { fileName, mimeType, bytes } = result.data;
  return new NextResponse(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": mimeType,
      "content-disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
    },
  });
}
