import { NextResponse } from "next/server";

import { approveContentThread, requestContentRevision } from "@/server/content/content-lifecycle-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toContentHttpResponse } from "@/server/content/http";
import { contentInvalidInputResult } from "@/server/content/types";

type RouteParams = { params: Promise<{ contentRef: string }> };

// POST /api/content/[contentRef]/review
// {decision: "APPROVED" | "REVISION_REQUESTED", reviewedRevisionNumber, expectedVersion, reason? (required when decision === "REVISION_REQUESTED")}
// Step 11A.1: repurposes the old review route - exactly the two Manager
// decisions that exist now (never a third "reject" option - see
// content-lifecycle-service.ts's own comment), each dispatched to its own
// distinct trusted service function.
export async function POST(request: Request, { params }: RouteParams) {
  const { contentRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  if (!body || typeof body !== "object") return toContentHttpResponse(contentInvalidInputResult("Invalid body."));
  const { decision, ...rest } = body as { decision?: unknown } & Record<string, unknown>;

  if (decision === "APPROVED") {
    const result = await approveContentThread(actor, contentRef, rest, newRequestId());
    return toContentHttpResponse(result);
  }

  if (decision === "REVISION_REQUESTED") {
    const result = await requestContentRevision(actor, contentRef, rest, newRequestId());
    return toContentHttpResponse(result);
  }

  return toContentHttpResponse(contentInvalidInputResult('decision must be "APPROVED" or "REVISION_REQUESTED".'));
}
