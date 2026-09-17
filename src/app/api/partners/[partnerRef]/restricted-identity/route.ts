import { NextResponse } from "next/server";

import { getPartnerRestrictedIdentity, savePartnerRestrictedIdentity } from "@/server/partners/restricted-identity-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toPartnersHttpResponse } from "@/server/partners/http";

type RouteParams = { params: Promise<{ partnerRef: string }> };

// GET/PUT /api/partners/[partnerRef]/restricted-identity - gated by
// manage_partner_restricted_identity AND the payment_details sensitive
// category (see partners-gate.ts). Never cached.
export async function GET(_request: Request, { params }: RouteParams) {
  const { partnerRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getPartnerRestrictedIdentity(actor, partnerRef);
  const response = toPartnersHttpResponse(result);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function PUT(request: Request, { params }: RouteParams) {
  const { partnerRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await savePartnerRestrictedIdentity(actor, partnerRef, body, newRequestId());
  const response = toPartnersHttpResponse(result);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
