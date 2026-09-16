import { NextResponse } from "next/server";

import { createLead, listLeads } from "@/server/discovery/lead-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

// GET /api/discovery/leads?limit=&cursorValue=&cursorUid=&lifecycle=&region=&platform=&assignedToMe=&search=&followUpDue=
export async function GET(request: Request) {
  const actor = await resolveRequestActor();

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursorValue = url.searchParams.get("cursorValue");
  const cursorUid = url.searchParams.get("cursorUid");

  const input = {
    limit: limitParam ? Number(limitParam) : undefined,
    cursor: cursorValue !== null && cursorUid ? { orderValue: cursorValue, uid: cursorUid } : undefined,
    lifecycle: url.searchParams.get("lifecycle") ?? undefined,
    region: url.searchParams.get("region") ?? undefined,
    platform: url.searchParams.get("platform") ?? undefined,
    assignedToMe: url.searchParams.get("assignedToMe") === "true" ? true : undefined,
    search: url.searchParams.get("search") ?? undefined,
    followUpDue: url.searchParams.get("followUpDue") === "true" ? true : undefined,
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
