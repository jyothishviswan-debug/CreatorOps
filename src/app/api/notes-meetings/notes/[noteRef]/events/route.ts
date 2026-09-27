import { listNoteEvents } from "@/server/notes-meetings";
import { resolveRequestActor, toNotesMeetingsHttpResponse } from "@/server/notes-meetings/http";

type RouteParams = { params: Promise<{ noteRef: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { noteRef } = await params;
  const actor = await resolveRequestActor();
  const result = await listNoteEvents(actor, noteRef);
  return toNotesMeetingsHttpResponse(result);
}
