import { NextResponse } from "next/server";

import { completeContent } from "@/server/content/content-lifecycle-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toContentHttpResponse } from "@/server/content/http";

type RouteParams = { params: Promise<{ contentRef: string }> };

// POST /api/content/[contentRef]/complete {expectedVersion}
export async function POST(request: Request, { params }: RouteParams) {
  const { contentRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await completeContent(actor, contentRef, body, newRequestId());
  return toContentHttpResponse(result);
}
