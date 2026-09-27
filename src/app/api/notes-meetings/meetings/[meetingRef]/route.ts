import { getMeeting } from "@/server/notes-meetings";
import { resolveRequestActor, toNotesMeetingsHttpResponse } from "@/server/notes-meetings/http";

type RouteParams = { params: Promise<{ meetingRef: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { meetingRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getMeeting(actor, meetingRef);
  return toNotesMeetingsHttpResponse(result);
}
