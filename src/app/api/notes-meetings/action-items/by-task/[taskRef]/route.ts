import { NextResponse } from "next/server";

import { findMeetingActionItemByTask } from "@/server/notes-meetings";
import { resolveRequestActor } from "@/server/notes-meetings/http";

type RouteParams = { params: Promise<{ taskRef: string }> };

// GET /api/notes-meetings/action-items/by-task/[taskRef] - the reverse deep link (spec section 19):
// used by the Operations Task detail page to offer "View source Meeting" when this exact actor can
// also see the owning Meeting. Never a hint that a link exists when the actor cannot see it - a
// denial and a genuine absence both return the same {found:false}.
export async function GET(_request: Request, { params }: RouteParams) {
  const { taskRef } = await params;
  const actor = await resolveRequestActor();
  const origin = await findMeetingActionItemByTask(actor, taskRef);
  return NextResponse.json(origin ? { found: true, ...origin } : { found: false });
}
