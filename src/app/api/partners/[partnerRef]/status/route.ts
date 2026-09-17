import { NextResponse } from "next/server";

import { setPartnerStatus } from "@/server/partners/partner-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toPartnersHttpResponse } from "@/server/partners/http";

type RouteParams = { params: Promise<{ partnerRef: string }> };

// POST /api/partners/[partnerRef]/status - the ordinary reversible
// ACTIVE <-> INACTIVE toggle. BLACKLISTED/ARCHIVED/restore are their own
// dedicated governance routes (see ../blacklist, ../archive, ../restore).
export async function POST(request: Request, { params }: RouteParams) {
  const { partnerRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await setPartnerStatus(actor, partnerRef, body, newRequestId());
  return toPartnersHttpResponse(result);
}
