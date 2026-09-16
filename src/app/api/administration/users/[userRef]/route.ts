import { NextResponse } from "next/server";

import { getUser, updateUser } from "@/server/administration/users-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toHttpResponse } from "@/server/administration/http";

type RouteParams = { params: Promise<{ userRef: string }> };

// GET /api/administration/users/[userRef]
export async function GET(_request: Request, { params }: RouteParams) {
  const { userRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getUser(actor, userRef);
  return toHttpResponse(result);
}

// PATCH /api/administration/users/[userRef] - displayName/role/active,
// guarded by optimistic concurrency (body must include expectedVersion).
export async function PATCH(request: Request, { params }: RouteParams) {
  const { userRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await updateUser(actor, userRef, body, newRequestId());
  return toHttpResponse(result);
}
