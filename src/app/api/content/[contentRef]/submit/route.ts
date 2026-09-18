import { NextResponse } from "next/server";

import { submitContentForReview } from "@/server/content/content-lifecycle-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toContentHttpResponse } from "@/server/content/http";

type RouteParams = { params: Promise<{ contentRef: string }> };

// POST /api/content/[contentRef]/submit {expectedVersion}
export async function POST(request: Request, { params }: RouteParams) {
  const { contentRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await submitContentForReview(actor, contentRef, body, newRequestId());
  return toContentHttpResponse(result);
}
