import { NextResponse } from "next/server";

import { createVendorPartnerLink, listLinksForVendor } from "@/server/vendors/vendor-partner-link-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toVendorsHttpResponse } from "@/server/vendors/http";

type RouteParams = { params: Promise<{ vendorRef: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { vendorRef } = await params;
  const actor = await resolveRequestActor();
  const result = await listLinksForVendor(actor, vendorRef);
  return toVendorsHttpResponse(result);
}

export async function POST(request: Request, { params }: RouteParams) {
  const { vendorRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createVendorPartnerLink(actor, vendorRef, body, newRequestId());
  return toVendorsHttpResponse(result, 201);
}
