import { NextResponse } from "next/server";

import { bulkSetAccessOverrides } from "@/server/administration/access-overrides-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toHttpResponse } from "@/server/administration/http";

type RouteParams = { params: Promise<{ userRef: string }> };

// POST /api/administration/users/[userRef]/access-overrides/bulk - Allow
// All Modules / Deny All Modules / Reset All Modules to Role Defaults
// (body: { mode: "allow_all" | "deny_all" | "reset_all", expectedVersion }).
export async function POST(request: Request, { params }: RouteParams) {
  const { userRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await bulkSetAccessOverrides(actor, userRef, body, newRequestId());
  return toHttpResponse(result);
}
