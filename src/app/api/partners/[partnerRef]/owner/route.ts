import { NextResponse } from "next/server";

import { setPartnerOwnerTeam } from "@/server/partners/partner-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toPartnersHttpResponse } from "@/server/partners/http";

type RouteParams = { params: Promise<{ partnerRef: string }> };

// POST /api/partners/[partnerRef]/owner - set owner/team, distinct
// action (manage_partner_ownership) from ordinary edit.
export async function POST(request: Request, { params }: RouteParams) {
  const { partnerRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await setPartnerOwnerTeam(actor, partnerRef, body, newRequestId());
  return toPartnersHttpResponse(result);
}
