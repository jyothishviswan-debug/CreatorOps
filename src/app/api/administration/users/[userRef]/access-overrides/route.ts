import { NextResponse } from "next/server";

import { setAccessOverride } from "@/server/administration/access-overrides-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toHttpResponse } from "@/server/administration/http";

type RouteParams = { params: Promise<{ userRef: string }> };

// PATCH /api/administration/users/[userRef]/access-overrides - set a
// single module or action override to inherit/allow/deny (body: {
// featureId, actionId?, value, expectedVersion }).
export async function PATCH(request: Request, { params }: RouteParams) {
  const { userRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await setAccessOverride(actor, userRef, body, newRequestId());
  return toHttpResponse(result);
}
