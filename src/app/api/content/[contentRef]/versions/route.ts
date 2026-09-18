import { NextResponse } from "next/server";

import { saveContentVersion } from "@/server/content/content-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toContentHttpResponse } from "@/server/content/http";

type RouteParams = { params: Promise<{ contentRef: string }> };

// POST /api/content/[contentRef]/versions {captionText?, sourceUrl?, submissionNotes?, attachmentRefs?, expectedVersion}
export async function POST(request: Request, { params }: RouteParams) {
  const { contentRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await saveContentVersion(actor, contentRef, body, newRequestId());
  return toContentHttpResponse(result, 201);
}
