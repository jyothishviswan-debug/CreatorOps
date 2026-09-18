import { NextResponse } from "next/server";

import { addPublicationEvidence } from "@/server/content/content-lifecycle-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toContentHttpResponse } from "@/server/content/http";

type RouteParams = { params: Promise<{ contentRef: string }> };

// POST /api/content/[contentRef]/publication-evidence {platform, url, platformContentId?, partnerAccountRef?, publishedAt?, expectedVersion}
export async function POST(request: Request, { params }: RouteParams) {
  const { contentRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await addPublicationEvidence(actor, contentRef, body, newRequestId());
  return toContentHttpResponse(result, 201);
}
