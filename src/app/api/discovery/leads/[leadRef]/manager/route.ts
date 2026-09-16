import { NextResponse } from "next/server";

import { assignManager } from "@/server/discovery/lead-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

type RouteParams = { params: Promise<{ leadRef: string }> };

// POST /api/discovery/leads/[leadRef]/manager - assign (or clear, via
// managerUserRef: null) the Lead's manager. Must reference a real,
// active, admitted user.
export async function POST(request: Request, { params }: RouteParams) {
  const { leadRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await assignManager(actor, leadRef, body, newRequestId());
  return toDiscoveryHttpResponse(result);
}
