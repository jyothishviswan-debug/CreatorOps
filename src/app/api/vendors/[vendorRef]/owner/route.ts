import { NextResponse } from "next/server";

import { setVendorOwnerTeam } from "@/server/vendors/vendor-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toVendorsHttpResponse } from "@/server/vendors/http";

type RouteParams = { params: Promise<{ vendorRef: string }> };

// POST /api/vendors/[vendorRef]/owner - set owner/team, distinct action
// (manage_vendor_ownership) from ordinary edit.
export async function POST(request: Request, { params }: RouteParams) {
  const { vendorRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await setVendorOwnerTeam(actor, vendorRef, body, newRequestId());
  return toVendorsHttpResponse(result);
}
