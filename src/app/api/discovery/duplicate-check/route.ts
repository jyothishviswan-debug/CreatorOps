import { NextResponse } from "next/server";

import { precheckDuplicates } from "@/server/discovery/lead-service";
import { parseJsonBody, resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

// POST /api/discovery/duplicate-check - pre-create check (no Lead exists
// yet, nothing is persisted). Body: { email?, phone?, profileUrl?, handle? }.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await precheckDuplicates(actor, body);
  return toDiscoveryHttpResponse(result);
}
