import { NextResponse } from "next/server";

import { editPartnerAccount, getPartnerAccount } from "@/server/partners/partner-account-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toPartnersHttpResponse } from "@/server/partners/http";

type RouteParams = { params: Promise<{ partnerAccountRef: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { partnerAccountRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getPartnerAccount(actor, partnerAccountRef);
  return toPartnersHttpResponse(result);
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { partnerAccountRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await editPartnerAccount(actor, partnerAccountRef, body, newRequestId());
  return toPartnersHttpResponse(result);
}
