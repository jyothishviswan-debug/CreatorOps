import { NextResponse } from "next/server";

import { createPartnerReviewRevision } from "@/server/partner-reviews/partner-review-lifecycle-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toPartnerReviewsHttpResponse } from "@/server/partner-reviews/http";

type RouteParams = { params: Promise<{ reviewRef: string }> };

// POST /api/partner-reviews/[reviewRef]/revision - Create the next Draft revision after finalized evidence went stale {expectedDocVersion} (the HEAD docVersion)
export async function POST(request: Request, { params }: RouteParams) {
  const { reviewRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createPartnerReviewRevision(actor, reviewRef, body, newRequestId());
  return toPartnerReviewsHttpResponse(result);
}
