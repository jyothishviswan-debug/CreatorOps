import { NextResponse } from "next/server";

import { setVendorStatus } from "@/server/vendors/vendor-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toVendorsHttpResponse } from "@/server/vendors/http";

type RouteParams = { params: Promise<{ vendorRef: string }> };

// POST /api/vendors/[vendorRef]/status - the ordinary reversible
// ACTIVE <-> INACTIVE toggle. ARCHIVED/restore are their own dedicated
// governance routes (see ../archive, ../restore).
export async function POST(request: Request, { params }: RouteParams) {
  const { vendorRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await setVendorStatus(actor, vendorRef, body, newRequestId());
  return toVendorsHttpResponse(result);
}
