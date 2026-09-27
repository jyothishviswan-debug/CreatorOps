import { NextResponse } from "next/server";

import { previewExportJob } from "@/server/exports";
import { parseJsonBody, resolveRequestActor, toExportsHttpResponse } from "@/server/exports/http";

// POST /api/exports/preview {targetId, format, columns?, filters?}
// Section 8: a real pre-generation preview. Reauthorizes exactly like job creation (same body shape,
// same target/format/column/filter validation - see export-service.ts's shared resolveExportPlan) but
// never writes a job doc or an artifact, and returns only a small, explicitly-labeled sample.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined || typeof body !== "object" || body === null) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await previewExportJob(actor, body);
  return toExportsHttpResponse(result);
}
