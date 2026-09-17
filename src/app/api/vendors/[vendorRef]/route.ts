import { NextResponse } from "next/server";

import { editVendor, getVendor } from "@/server/vendors/vendor-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toVendorsHttpResponse } from "@/server/vendors/http";

type RouteParams = { params: Promise<{ vendorRef: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { vendorRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getVendor(actor, vendorRef);
  return toVendorsHttpResponse(result);
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { vendorRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await editVendor(actor, vendorRef, body, newRequestId());
  return toVendorsHttpResponse(result);
}
