import { NextResponse } from "next/server";

import { finalizeReport } from "@/server/reports";
import { parseJsonBody, resolveRequestActor, toReportsHttpResponse } from "@/server/reports/http";

// POST /api/reports/finalize {reportId, filters?}
// Section 15: runs the report (full, non-viewer-safe) and persists one immutable finalized snapshot.
// Requires run_reports, same as a regular run - see snapshot-service.ts's finalizeReport.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await finalizeReport(actor, body);
  if (!result.ok) return toReportsHttpResponse(result);
  return NextResponse.json(result.data, { status: 201 });
}
