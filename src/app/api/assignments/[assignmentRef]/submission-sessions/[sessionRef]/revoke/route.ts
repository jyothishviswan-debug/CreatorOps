import { revokeExternalSubmissionSession } from "@/server/assignments/external-submission-service";
import { newRequestId, resolveRequestActor, toAssignmentsHttpResponse } from "@/server/assignments/http";

type RouteParams = { params: Promise<{ assignmentRef: string; sessionRef: string }> };

// POST /api/assignments/[assignmentRef]/submission-sessions/[sessionRef]/revoke
// Internal, trusted, action-gated. Regeneration (issuing a new link) is
// just create-new + revoke-old, called separately by staff - there is no
// combined "regenerate" endpoint, matching Step 10A section 16's own
// "optionally regenerate as create-new + revoke-old behavior".
export async function POST(_request: Request, { params }: RouteParams) {
  const { assignmentRef, sessionRef } = await params;
  const actor = await resolveRequestActor();

  const result = await revokeExternalSubmissionSession(actor, assignmentRef, sessionRef, newRequestId());
  return toAssignmentsHttpResponse(result);
}
