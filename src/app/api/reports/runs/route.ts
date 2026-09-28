import { NextResponse } from "next/server";

import { createDraftReportRun } from "@/server/reports";
import { parseJsonBody, resolveRequestActor, toReportLifecycleHttpResponse } from "@/server/reports/http";
import { checkRateLimit, requestIpKey } from "@/server/shared/rate-limit";

// Production hardening (base spec section 21 - rate limiting / abuse control): "expensive Reports
// runs/artifacts" is named directly by example. Rate-limited PER ACTOR before a new run is created.
// See src/server/shared/rate-limit.ts for the shared abstraction.
const MAX_REPORT_RUNS_PER_WINDOW = 30;
const REPORT_RUN_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// POST /api/reports/runs {templateId, filters?}
// Reports Final-Master (spec section 12): step 1 of the publication workflow - create a DRAFT
// ReportRun/Version for a chosen template. Requires run_reports (same action a plain report run
// requires) plus current FeatureAccess to every source module the underlying report reads through.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();

  const dimension = actor ? actor.uid : requestIpKey(request);
  const decision = checkRateLimit("reports_runs_create", dimension, MAX_REPORT_RUNS_PER_WINDOW, REPORT_RUN_WINDOW_MS);
  if (!decision.allowed) {
    return NextResponse.json({ error: "Too many report-run requests. Try again shortly." }, { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } });
  }

  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await createDraftReportRun(actor, body);
  return toReportLifecycleHttpResponse(result, 201);
}
