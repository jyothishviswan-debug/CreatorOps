import { NextResponse } from "next/server";

import { createSupersedingReportVersion } from "@/server/reports";
import { parseJsonBody, resolveRequestActor, toReportLifecycleHttpResponse } from "@/server/reports/http";

// POST /api/reports/runs/[runRef]/supersede {expectedDocVersion}
// Reports Final-Master (spec section 16): open a correcting DRAFT version from the current finalized
// one. Never overwrites the prior FINALIZED version or its artifacts - supersession happens only when
// the NEW version itself finalizes.
export async function POST(request: Request, { params }: { params: Promise<{ runRef: string }> }) {
  const actor = await resolveRequestActor();
  const { runRef } = await params;
  const body = await parseJsonBody(request);
  if (body === undefined || typeof body !== "object" || body === null) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await createSupersedingReportVersion(actor, { runRef, ...(body as object) });
  return toReportLifecycleHttpResponse(result, 201);
}
