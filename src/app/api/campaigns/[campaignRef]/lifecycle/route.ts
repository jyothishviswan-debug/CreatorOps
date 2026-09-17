import { NextResponse } from "next/server";

import { transitionCampaignLifecycle } from "@/server/campaigns/campaign-lifecycle-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toCampaignsHttpResponse } from "@/server/campaigns/http";

type RouteParams = { params: Promise<{ campaignRef: string }> };

// POST /api/campaigns/[campaignRef]/lifecycle {to, reason?, expectedVersion}
// The single trusted entry point for every Campaign lifecycle edge - see
// transitionCampaignLifecycle's own comment for the action-gating split
// (ordinary transitions vs cancel vs archive) and the DRAFT -> PLANNED
// readiness gate.
export async function POST(request: Request, { params }: RouteParams) {
  const { campaignRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await transitionCampaignLifecycle(actor, campaignRef, body, newRequestId());
  return toCampaignsHttpResponse(result);
}
