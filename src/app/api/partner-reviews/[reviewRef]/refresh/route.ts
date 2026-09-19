import { NextResponse } from "next/server";

import { refreshPartnerReviewEvidence } from "@/server/partner-reviews/partner-review-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toPartnerReviewsHttpResponse } from "@/server/partner-reviews/http";

type RouteParams = { params: Promise<{ reviewRef: string }> };

// POST /api/partner-reviews/[reviewRef]/refresh - Recompute the open Draft/In Review version's evidence {version?, expectedDocVersion}
export async function POST(request: Request, { params }: RouteParams) {
  const { reviewRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await refreshPartnerReviewEvidence(actor, reviewRef, body, newRequestId());
  return toPartnerReviewsHttpResponse(result);
}
