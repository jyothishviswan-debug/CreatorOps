import { searchActiveUsersForNotesMeetings } from "@/server/notes-meetings";
import { optionalIntegerParam, optionalStringParam, resolveRequestActor, toNotesMeetingsHttpResponse } from "@/server/notes-meetings/http";

// GET /api/notes-meetings/users/search?emailPrefix=&limit= - see user-search.ts's own comment for
// why this is gated on Authentication+Admission only, not any one owning feature.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);
  const result = await searchActiveUsersForNotesMeetings(actor, { emailPrefix: optionalStringParam(searchParams, "emailPrefix"), limit: optionalIntegerParam(searchParams, "limit") });
  return toNotesMeetingsHttpResponse(result);
}
