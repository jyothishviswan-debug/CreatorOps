import { NextResponse } from "next/server";

import { editCampaign, getCampaign } from "@/server/campaigns/campaign-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toCampaignsHttpResponse } from "@/server/campaigns/http";

type RouteParams = { params: Promise<{ campaignRef: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { campaignRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getCampaign(actor, campaignRef);
  return toCampaignsHttpResponse(result);
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { campaignRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await editCampaign(actor, campaignRef, body, newRequestId());
  return toCampaignsHttpResponse(result);
}
