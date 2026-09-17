import { NextResponse } from "next/server";

import { restoreVendorPartnerLink } from "@/server/vendors/vendor-partner-link-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toVendorsHttpResponse } from "@/server/vendors/http";

type RouteParams = { params: Promise<{ linkRef: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const { linkRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await restoreVendorPartnerLink(actor, linkRef, body, newRequestId());
  return toVendorsHttpResponse(result);
}
