import { NextResponse } from "next/server";

import { runReport } from "@/server/reports";
import { parseJsonBody, resolveRequestActor, toReportsHttpResponse } from "@/server/reports/http";

// POST /api/reports/[reportId]/viewer-run {filters?}
// Section 17: the Viewer boundary. Needs only the plain "reports" FeatureAccess grant (no
// run_reports action) - the sanctioned, restricted execution surface for a view-only role. Never
// exposes Finance/Administration-sensitive families (see report-service.ts's
// VIEWER_SAFE_BLOCKED_REPORT_IDS) and strips internal provenance detail from the result.
export async function POST(request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const actor = await resolveRequestActor();
  const { reportId } = await params;
  const body = await parseJsonBody(request);
  if (body !== undefined && (typeof body !== "object" || body === null)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const filters = body && typeof body === "object" && "filters" in body ? (body as { filters?: unknown }).filters : undefined;
  const result = await runReport(actor, reportId, filters && typeof filters === "object" ? (filters as Record<string, unknown>) : undefined, { viewerSafe: true });
  return toReportsHttpResponse(result);
}
