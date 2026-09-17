import { NextResponse } from "next/server";

import { createLead, listLeads } from "@/server/discovery/lead-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

// GET /api/discovery/leads?limit=&cursor=&lifecycle=&region=&platform=&assignedToMe=&search=&followUpDue=
// `cursor` is an opaque JSON-encoded compound cursor (see
// src/server/shared/scoped-list.ts) - listLeads itself re-validates its
// shape (compoundListCursorSchema) before trusting it.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursorRaw = url.searchParams.get("cursor");
  let cursor: unknown;
  if (cursorRaw) {
    try {
      cursor = JSON.parse(cursorRaw);
    } catch {
      cursor = undefined;
    }
  }

  const regionValues = url.searchParams.getAll("region");

  const input = {
    limit: limitParam ? Number(limitParam) : undefined,
    cursor,
    lifecycle: url.searchParams.get("lifecycle") ?? undefined,
    region: regionValues.length > 0 ? regionValues : undefined,
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
