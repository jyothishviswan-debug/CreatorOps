import { NextResponse } from "next/server";

import { addSensitiveGrant, getSensitiveGrants, removeSensitiveGrant } from "@/server/administration/sensitive-grants-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toHttpResponse } from "@/server/administration/http";

type RouteParams = { params: Promise<{ role: string }> };

// GET /api/administration/roles/[role]/sensitive-grants
export async function GET(_request: Request, { params }: RouteParams) {
  const { role } = await params;
  const actor = await resolveRequestActor();
  const result = await getSensitiveGrants(actor, role);
  return toHttpResponse(result);
}

// POST /api/administration/roles/[role]/sensitive-grants - add a
// sensitive-access category to this role's existing canonical
// (Step 4B) sensitiveAccessGrants/{role} document.
export async function POST(request: Request, { params }: RouteParams) {
  const { role } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await addSensitiveGrant(actor, role, body, newRequestId());
  return toHttpResponse(result, 201);
}

// DELETE /api/administration/roles/[role]/sensitive-grants
export async function DELETE(request: Request, { params }: RouteParams) {
  const { role } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await removeSensitiveGrant(actor, role, body, newRequestId());
  return toHttpResponse(result);
}
