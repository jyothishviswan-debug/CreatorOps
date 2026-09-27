import { NextResponse } from "next/server";

import { submitReportForReview } from "@/server/reports";
import { parseJsonBody, resolveRequestActor, toReportLifecycleHttpResponse } from "@/server/reports/http";

// POST /api/reports/runs/[runRef]/submit-review {expectedDocVersion}
export async function POST(request: Request, { params }: { params: Promise<{ runRef: string }> }) {
  const actor = await resolveRequestActor();
  const { runRef } = await params;
  const body = await parseJsonBody(request);
  if (body === undefined || typeof body !== "object" || body === null) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await submitReportForReview(actor, { runRef, ...(body as object) });
  return toReportLifecycleHttpResponse(result);
}
