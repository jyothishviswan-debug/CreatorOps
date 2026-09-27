import { NextResponse } from "next/server";

import { saveNarrativeSection } from "@/server/reports";
import { parseJsonBody, resolveRequestActor, toReportLifecycleHttpResponse } from "@/server/reports/http";

// POST /api/reports/runs/[runRef]/narrative {version, sectionKey, title?, body, expectedRevision}
// Reports Final-Master (spec section 14): save one narrative section revision, with optimistic
// stale-conflict detection via expectedRevision (0 for a section's first save).
export async function POST(request: Request, { params }: { params: Promise<{ runRef: string }> }) {
  const actor = await resolveRequestActor();
  const { runRef } = await params;
  const body = await parseJsonBody(request);
  if (body === undefined || typeof body !== "object" || body === null) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await saveNarrativeSection(actor, { runRef, ...(body as object) });
  return toReportLifecycleHttpResponse(result);
}
