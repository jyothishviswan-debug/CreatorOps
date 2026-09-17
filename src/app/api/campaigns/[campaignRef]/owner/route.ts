import { NextResponse } from "next/server";

import { setCampaignOwnerTeam } from "@/server/campaigns/campaign-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toCampaignsHttpResponse } from "@/server/campaigns/http";

type RouteParams = { params: Promise<{ campaignRef: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const { campaignRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await setCampaignOwnerTeam(actor, campaignRef, body, newRequestId());
  return toCampaignsHttpResponse(result);
}
