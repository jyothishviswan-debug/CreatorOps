import { NextResponse } from "next/server";

import { restoreLead } from "@/server/discovery/lifecycle-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

type RouteParams = { params: Promise<{ leadRef: string }> };

// POST /api/discovery/leads/[leadRef]/lifecycle/restore - reasoned,
// authorized restore out of WATCHLIST/REJECTED/ARCHIVED back to this
// Lead's own recorded previousLifecycle (body: { reason, expectedVersion }).
export async function POST(request: Request, { params }: RouteParams) {
  const { leadRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await restoreLead(actor, leadRef, body, newRequestId());
  return toDiscoveryHttpResponse(result);
}
