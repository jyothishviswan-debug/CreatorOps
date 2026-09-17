import { NextResponse } from "next/server";

import { editVendorPartnerLink } from "@/server/vendors/vendor-partner-link-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toVendorsHttpResponse } from "@/server/vendors/http";

type RouteParams = { params: Promise<{ linkRef: string }> };

// PATCH /api/vendors/links/[linkRef] - safe relationship metadata only
// (relationshipType/payeeRole/effectiveFrom). Ending or restoring a
// relationship are their own dedicated routes (see ./end, ./restore).
export async function PATCH(request: Request, { params }: RouteParams) {
  const { linkRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await editVendorPartnerLink(actor, linkRef, body, newRequestId());
  return toVendorsHttpResponse(result);
}
