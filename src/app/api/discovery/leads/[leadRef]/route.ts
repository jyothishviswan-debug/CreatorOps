import { NextResponse } from "next/server";

import { getLead, updateLead } from "@/server/discovery/lead-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

type RouteParams = { params: Promise<{ leadRef: string }> };

// GET /api/discovery/leads/[leadRef]
export async function GET(_request: Request, { params }: RouteParams) {
  const { leadRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getLead(actor, leadRef);
  return toDiscoveryHttpResponse(result);
}

// PATCH /api/discovery/leads/[leadRef] - ordinary fields only, guarded by
// optimistic concurrency (body must include expectedVersion).
export async function PATCH(request: Request, { params }: RouteParams) {
  const { leadRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await updateLead(actor, leadRef, body, newRequestId());
  return toDiscoveryHttpResponse(result);
}
