import { NextResponse } from "next/server";

import { restoreVendor } from "@/server/vendors/vendor-lifecycle-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toVendorsHttpResponse } from "@/server/vendors/http";

type RouteParams = { params: Promise<{ vendorRef: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const { vendorRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await restoreVendor(actor, vendorRef, body, newRequestId());
  return toVendorsHttpResponse(result);
}
