import { NextResponse } from "next/server";

import { transitionAssignmentLifecycle } from "@/server/assignments/assignment-lifecycle-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toAssignmentsHttpResponse } from "@/server/assignments/http";

type RouteParams = { params: Promise<{ assignmentRef: string }> };

// POST /api/assignments/[assignmentRef]/lifecycle {to, reason?, expectedVersion}
// The single trusted entry point for every Assignment lifecycle edge -
// see transitionAssignmentLifecycle's own comment for the action-gating
// split (ordinary transitions vs cancel) and why IN_PROGRESS -> COMPLETED
// always fails closed in this build.
export async function POST(request: Request, { params }: RouteParams) {
  const { assignmentRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await transitionAssignmentLifecycle(actor, assignmentRef, body, newRequestId());
  return toAssignmentsHttpResponse(result);
}
