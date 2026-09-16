import { NextResponse } from "next/server";

import { checkLeadDuplicates } from "@/server/discovery/lead-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

type RouteParams = { params: Promise<{ leadRef: string }> };

// POST /api/discovery/leads/[leadRef]/duplicate-check - runs a fresh
// bounded duplicate lookup against this Lead's own identity fields and
// persists the result (body: { expectedVersion }).
export async function POST(request: Request, { params }: RouteParams) {
  const { leadRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await checkLeadDuplicates(actor, leadRef, body, newRequestId());
  return toDiscoveryHttpResponse(result);
}
