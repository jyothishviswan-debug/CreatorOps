import { NextResponse } from "next/server";

import { addCampaignResource, editCampaignResource, removeCampaignResource } from "@/server/campaigns/campaign-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toCampaignsHttpResponse } from "@/server/campaigns/http";

type RouteParams = { params: Promise<{ campaignRef: string }> };

// POST/PATCH/DELETE /api/campaigns/[campaignRef]/resources - bounded
// ordinary resource metadata only (never a secret, never restricted
// identity, never an Agreement contract file - see types.ts's own
// comment). PATCH/DELETE identify the target resource by `resourceRef`
// in the body, not a URL segment - the collection is small and embedded
// on the Campaign document itself, never its own top-level collection.
export async function POST(request: Request, { params }: RouteParams) {
  const { campaignRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await addCampaignResource(actor, campaignRef, body, newRequestId());
  return toCampaignsHttpResponse(result, 201);
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { campaignRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await editCampaignResource(actor, campaignRef, body, newRequestId());
  return toCampaignsHttpResponse(result);
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const { campaignRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await removeCampaignResource(actor, campaignRef, body, newRequestId());
  return toCampaignsHttpResponse(result);
}
