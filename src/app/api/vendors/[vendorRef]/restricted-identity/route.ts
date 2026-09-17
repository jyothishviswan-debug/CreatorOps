import { NextResponse } from "next/server";

import { getVendorRestrictedIdentity, saveVendorRestrictedIdentity } from "@/server/vendors/restricted-identity-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toVendorsHttpResponse } from "@/server/vendors/http";

type RouteParams = { params: Promise<{ vendorRef: string }> };

// GET/PUT /api/vendors/[vendorRef]/restricted-identity - gated by
// manage_vendor_restricted_identity AND the vendor_payment_details
// sensitive category (see vendors-gate.ts). Never cached.
export async function GET(_request: Request, { params }: RouteParams) {
  const { vendorRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getVendorRestrictedIdentity(actor, vendorRef);
  const response = toVendorsHttpResponse(result);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function PUT(request: Request, { params }: RouteParams) {
  const { vendorRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await saveVendorRestrictedIdentity(actor, vendorRef, body, newRequestId());
  const response = toVendorsHttpResponse(result);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
