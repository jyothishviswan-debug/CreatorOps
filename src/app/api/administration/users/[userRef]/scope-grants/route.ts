import { NextResponse } from "next/server";

import { addScopeGrant, removeScopeGrant } from "@/server/administration/scope-grants-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toHttpResponse } from "@/server/administration/http";

type RouteParams = { params: Promise<{ userRef: string }> };

// POST /api/administration/users/[userRef]/scope-grants - add a Step 4C
// canonical scope grant (body: { type, ...discriminator }).
export async function POST(request: Request, { params }: RouteParams) {
  const { userRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await addScopeGrant(actor, userRef, body, newRequestId());
  return toHttpResponse(result, 201);
}

// DELETE /api/administration/users/[userRef]/scope-grants - remove a
// grant, identified the same way it was created (body: { type, ...
// discriminator }), not by a raw Firestore document id.
export async function DELETE(request: Request, { params }: RouteParams) {
  const { userRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await removeScopeGrant(actor, userRef, body, newRequestId());
  return toHttpResponse(result);
}
