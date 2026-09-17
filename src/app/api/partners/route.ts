import { NextResponse } from "next/server";

import { createPartner, listPartners } from "@/server/partners/partner-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toPartnersHttpResponse } from "@/server/partners/http";
import type { PartnerListCursor } from "@/server/partners/firestore";

// GET /api/partners - scoped, bounded, cursor-paginated list.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);

  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const displayNamePrefix = url.searchParams.get("displayNamePrefix") ?? undefined;

  let cursor: PartnerListCursor | undefined;
  const cursorOrderValue = url.searchParams.get("cursorOrderValue");
  const cursorUid = url.searchParams.get("cursorUid");
  if (cursorOrderValue && cursorUid) cursor = { orderValue: cursorOrderValue, uid: cursorUid };

  const result = await listPartners(actor, { limit, cursor, status, displayNamePrefix });
  return toPartnersHttpResponse(result);
}

// POST /api/partners - direct Partner creation (trusted server, action-gated).
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createPartner(actor, body, newRequestId());
  return toPartnersHttpResponse(result, 201);
}
