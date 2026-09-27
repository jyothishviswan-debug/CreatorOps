import { NextResponse } from "next/server";

import { finalizeReportVersion } from "@/server/reports";
import { parseJsonBody, resolveRequestActor, toReportLifecycleHttpResponse } from "@/server/reports/http";

// POST /api/reports/runs/[runRef]/finalize {expectedDocVersion}
// Reports Final-Master (spec section 15): pins evidence+narrative, creates the FINALIZED
// ReportVersion, generates declared artifacts, and supersedes the prior finalized version if any.
// Idempotent/race-safe - see report-lifecycle-service.ts's own finalizeReportVersion.
export async function POST(request: Request, { params }: { params: Promise<{ runRef: string }> }) {
  const actor = await resolveRequestActor();
  const { runRef } = await params;
  const body = await parseJsonBody(request);
  if (body === undefined || typeof body !== "object" || body === null) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await finalizeReportVersion(actor, { runRef, ...(body as object) });
  return toReportLifecycleHttpResponse(result);
}
