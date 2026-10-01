import { NextResponse } from "next/server";

import { recordContentLinksOnBehalf } from "@/server/content/manager-submission-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toContentHttpResponse } from "@/server/content/http";

// POST /api/content/record-links {assignmentRef, rows: [{platform, url}]} - finding #44 (user-decided):
// a Manager recording content links on the Partner's behalf. Keyed by assignmentRef, not contentRef - the
// Content thread may not exist yet (resolveOrCreateContentThread creates it, exactly like the public
// submission path already does). Requires the real record_content_links action; never a public/token path.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await recordContentLinksOnBehalf(actor, body, newRequestId());
  return toContentHttpResponse(result);
}
