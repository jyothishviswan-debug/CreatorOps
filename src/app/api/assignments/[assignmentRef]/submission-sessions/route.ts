import { NextResponse } from "next/server";

import { createExternalSubmissionSession, getActiveSubmissionSessionForRecipient } from "@/server/assignments/external-submission-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toAssignmentsHttpResponse } from "@/server/assignments/http";

type RouteParams = { params: Promise<{ assignmentRef: string }> };

// GET /api/assignments/[assignmentRef]/submission-sessions?recipientType=&recipientRef=
// Step 11A.1 section 12: a bounded pre-check so the Share dialog can
// detect an already-eligible active session BEFORE attempting creation,
// instead of a blind create-then-fail. Returns { session: null } when
// none exists.
export async function GET(request: Request, { params }: RouteParams) {
  const { assignmentRef } = await params;
  const actor = await resolveRequestActor();
  const url = new URL(request.url);
  const recipientType = url.searchParams.get("recipientType") ?? undefined;
  const recipientRef = url.searchParams.get("recipientRef") ?? undefined;

  const result = await getActiveSubmissionSessionForRecipient(actor, assignmentRef, recipientType, recipientRef);
  return toAssignmentsHttpResponse(result);
}

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
