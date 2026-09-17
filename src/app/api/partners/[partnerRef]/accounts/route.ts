import { NextResponse } from "next/server";

import { createPartnerAccount, listPartnerAccounts } from "@/server/partners/partner-account-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toPartnersHttpResponse } from "@/server/partners/http";

type RouteParams = { params: Promise<{ partnerRef: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { partnerRef } = await params;
  const actor = await resolveRequestActor();
  const result = await listPartnerAccounts(actor, partnerRef);
  return toPartnersHttpResponse(result);
}

export async function POST(request: Request, { params }: RouteParams) {
  const { partnerRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createPartnerAccount(actor, partnerRef, body, newRequestId());
  return toPartnersHttpResponse(result, 201);
}
