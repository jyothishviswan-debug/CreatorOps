import { NextResponse } from "next/server";

import { blacklistPartner } from "@/server/partners/partner-lifecycle-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toPartnersHttpResponse } from "@/server/partners/http";

type RouteParams = { params: Promise<{ partnerRef: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const { partnerRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await blacklistPartner(actor, partnerRef, body, newRequestId());
  return toPartnersHttpResponse(result);
}
