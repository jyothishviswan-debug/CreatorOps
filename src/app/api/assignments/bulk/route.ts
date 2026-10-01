import { NextResponse } from "next/server";

import { createAssignmentsForPartners } from "@/server/assignments/assignment-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toAssignmentsHttpResponse } from "@/server/assignments/http";

// POST /api/assignments/bulk - findings #40/#42/#51 (user-decided): the ONE logical bulk-create request
// (Direct multi-select or Through-Vendor mode both build the same Partner-ref list and land here) - never
// a client-side loop of individual POST /api/assignments calls. Always 200 with a per-Partner results
// array (created/existing/error) - a per-Partner failure never fails the whole request with a top-level
// error status, since the batch is deliberately partial-success-safe.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createAssignmentsForPartners(actor, body, newRequestId());
  if (!result.ok) return toAssignmentsHttpResponse(result);
  return NextResponse.json(result.data, { status: 200 });
}
