import { NextResponse } from "next/server";

import { createLead, listLeads } from "@/server/discovery/lead-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

// GET /api/discovery/leads?limit=&cursorCreatedAt=&cursorUid=&lifecycle=
export async function GET(request: Request) {
  const actor = await resolveRequestActor();

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursorCreatedAt = url.searchParams.get("cursorCreatedAt");
  const cursorUid = url.searchParams.get("cursorUid");
  const lifecycle = url.searchParams.get("lifecycle");

  const input = {
    limit: limitParam ? Number(limitParam) : undefined,
    cursor: cursorCreatedAt && cursorUid ? { createdAt: cursorCreatedAt, uid: cursorUid } : undefined,
    lifecycle: lifecycle ?? undefined,
  };

  const result = await listLeads(actor, input);
  return toDiscoveryHttpResponse(result);
}

// POST /api/discovery/leads
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createLead(actor, body, newRequestId());
  return toDiscoveryHttpResponse(result, 201);
}
