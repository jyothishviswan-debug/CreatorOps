import { NextResponse } from "next/server";

import { editAssignmentBrief, getAssignment } from "@/server/assignments/assignment-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toAssignmentsHttpResponse } from "@/server/assignments/http";

type RouteParams = { params: Promise<{ assignmentRef: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { assignmentRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getAssignment(actor, assignmentRef);
  return toAssignmentsHttpResponse(result);
}

// PATCH - edit draft brief fields only (see editAssignmentBrief's own
// comment: refused once the Assignment is past DRAFT).
export async function PATCH(request: Request, { params }: RouteParams) {
  const { assignmentRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await editAssignmentBrief(actor, assignmentRef, body, newRequestId());
  return toAssignmentsHttpResponse(result);
}
