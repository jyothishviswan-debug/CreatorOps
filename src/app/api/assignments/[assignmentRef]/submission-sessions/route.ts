import { NextResponse } from "next/server";

import { createExternalSubmissionSession } from "@/server/assignments/external-submission-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toAssignmentsHttpResponse } from "@/server/assignments/http";

type RouteParams = { params: Promise<{ assignmentRef: string }> };

// POST /api/assignments/[assignmentRef]/submission-sessions
// {recipientType, recipientRef?, expiresInMs?}
// Internal, trusted, action-gated (manage_assignment_external_submission)
// - called ONLY when a human staff member explicitly asks for a
// submission link, never automatically. The raw bearer token is present
// in this ONE response only; it is never persisted or returned again.
export async function POST(request: Request, { params }: RouteParams) {
  const { assignmentRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createExternalSubmissionSession(actor, assignmentRef, body, newRequestId());
  return toAssignmentsHttpResponse(result, 201);
}
