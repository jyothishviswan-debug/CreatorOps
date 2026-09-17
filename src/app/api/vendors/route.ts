import { NextResponse } from "next/server";

import { createVendor, listVendors } from "@/server/vendors/vendor-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toVendorsHttpResponse } from "@/server/vendors/http";
import type { VendorListCursor } from "@/server/vendors/firestore";

// GET /api/vendors - scoped, bounded, cursor-paginated list.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);

  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const displayNamePrefix = url.searchParams.get("displayNamePrefix") ?? undefined;
  const region = url.searchParams.get("region") ?? undefined;
  const vendorType = url.searchParams.get("vendorType") ?? undefined;
  const assignedToMe = url.searchParams.get("assignedToMe") === "true" ? true : undefined;

  let cursor: VendorListCursor | undefined;
  const cursorOrderValue = url.searchParams.get("cursorOrderValue");
  const cursorUid = url.searchParams.get("cursorUid");
  if (cursorOrderValue && cursorUid) cursor = { orderValue: cursorOrderValue, uid: cursorUid };

  const result = await listVendors(actor, { limit, cursor, status, displayNamePrefix, region, vendorType, assignedToMe });
  return toVendorsHttpResponse(result);
}

// POST /api/vendors - direct Vendor creation (trusted server, action-gated).
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createVendor(actor, body, newRequestId());
  return toVendorsHttpResponse(result, 201);
}
