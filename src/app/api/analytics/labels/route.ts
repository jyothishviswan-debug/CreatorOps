import { NextResponse } from "next/server";

import { resolveAnalyticsLabels } from "@/server/analytics/label-resolution";
import { parseJsonBody, resolveRequestActor, toAnalyticsHttpResponse } from "@/server/analytics/http";

// POST /api/analytics/labels - bounded bulk ref -> safe display label
// resolution for the Data Explorer (see label-resolution.ts). A read,
// not a mutation - POST only because the ref lists can exceed a
// comfortable query-string length, same rationale as other bulk-lookup
// endpoints in this app.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await resolveAnalyticsLabels(actor, body);
  return toAnalyticsHttpResponse(result);
}
