import { listActionItemEvents } from "@/server/notes-meetings";
import { resolveRequestActor, toNotesMeetingsHttpResponse } from "@/server/notes-meetings/http";

type RouteParams = { params: Promise<{ actionItemRef: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { actionItemRef } = await params;
  const actor = await resolveRequestActor();
  const result = await listActionItemEvents(actor, actionItemRef);
  return toNotesMeetingsHttpResponse(result);
}
