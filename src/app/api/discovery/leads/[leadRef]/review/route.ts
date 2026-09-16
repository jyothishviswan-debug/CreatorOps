import { NextResponse } from "next/server";

import { recordReview } from "@/server/discovery/lead-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

type RouteParams = { params: Promise<{ leadRef: string }> };

// POST /api/discovery/leads/[leadRef]/review
export async function POST(request: Request, { params }: RouteParams) {
  const { leadRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await recordReview(actor, leadRef, body, newRequestId());
  return toDiscoveryHttpResponse(result);
}
