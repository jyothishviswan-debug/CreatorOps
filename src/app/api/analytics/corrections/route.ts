import { NextResponse } from "next/server";

import { resolveAnalyticsSourceRecordMatch } from "@/server/analytics/correction-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toAnalyticsHttpResponse } from "@/server/analytics/http";

// POST /api/analytics/corrections - the trusted match correction/
// resolution contract (Section 13). No UI in this step - a direct,
// authorization-gated service call, same as every other trusted mutation
// route in this codebase.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await resolveAnalyticsSourceRecordMatch(actor, body, newRequestId());
  return toAnalyticsHttpResponse(result);
}
