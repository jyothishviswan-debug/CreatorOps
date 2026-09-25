import { NextResponse } from "next/server";

import { runReport } from "@/server/reports";
import { parseJsonBody, resolveRequestActor, toReportsHttpResponse } from "@/server/reports/http";

// POST /api/reports/[reportId]/run {filters?}
// The full/regular run path - requires the `run_reports` ActionPermission (section 8/17: Viewer's
// role baseline does not hold this; Viewer instead uses viewer-run). Every declared source module
// FeatureAccess is additionally required before this composes anything (section 11).
export async function POST(request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const actor = await resolveRequestActor();
  const { reportId } = await params;
  const body = await parseJsonBody(request);
  if (body !== undefined && (typeof body !== "object" || body === null)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const filters = body && typeof body === "object" && "filters" in body ? (body as { filters?: unknown }).filters : undefined;
  const result = await runReport(actor, reportId, filters && typeof filters === "object" ? (filters as Record<string, unknown>) : undefined, {});
  return toReportsHttpResponse(result);
}
