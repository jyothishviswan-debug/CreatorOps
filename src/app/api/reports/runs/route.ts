import { NextResponse } from "next/server";

import { createDraftReportRun } from "@/server/reports";
import { parseJsonBody, resolveRequestActor, toReportLifecycleHttpResponse } from "@/server/reports/http";

// POST /api/reports/runs {templateId, filters?}
// Reports Final-Master (spec section 12): step 1 of the publication workflow - create a DRAFT
// ReportRun/Version for a chosen template. Requires run_reports (same action a plain report run
// requires) plus current FeatureAccess to every source module the underlying report reads through.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await createDraftReportRun(actor, body);
  return toReportLifecycleHttpResponse(result, 201);
}
