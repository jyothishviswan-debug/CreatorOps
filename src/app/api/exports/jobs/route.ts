import { NextResponse } from "next/server";

import { createExportJob, listMyExportJobs } from "@/server/exports";
import { parseJsonBody, resolveRequestActor, toExportsHttpResponse } from "@/server/exports/http";

// GET /api/exports/jobs?limit=
// The acting user's OWN export job history, newest first - never another actor's jobs.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);
  const limit = url.searchParams.get("limit") ?? undefined;
  const result = await listMyExportJobs(actor, limit);
  return toExportsHttpResponse(result);
}

// POST /api/exports/jobs {targetId, format, columns?, filters?}
// Create + synchronously generate a governed export job. Every id in the request body is
// server-validated against the target's own catalog entry (target existence, allowed format,
// allowed/duplicate-free columns, declared filters) before any source read happens - see
// export-service.ts's createExportJob for the exact validation order.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined || typeof body !== "object" || body === null) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createExportJob(actor, body);
  return toExportsHttpResponse(result, 201);
}
