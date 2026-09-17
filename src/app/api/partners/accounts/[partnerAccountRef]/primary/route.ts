import { NextResponse } from "next/server";

import { setPrimaryPartnerAccount } from "@/server/partners/partner-account-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toPartnersHttpResponse } from "@/server/partners/http";

type RouteParams = { params: Promise<{ partnerAccountRef: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const { partnerAccountRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await setPrimaryPartnerAccount(actor, partnerAccountRef, body, newRequestId());
  return toPartnersHttpResponse(result);
}
