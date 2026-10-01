import { NextResponse } from "next/server";

import { generateReviewsForItems } from "@/server/partner-reviews/partner-review-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toPartnerReviewsHttpResponse } from "@/server/partner-reviews/http";

// POST /api/partner-reviews/bulk {items: [{partnerRef, periodKey}]}
// Finding #63: the ONE logical bulk-generate request - never a client-side loop of individual
// POST /api/partner-reviews calls. Always 200 with a per-item results array
// (created/existing/error) - a single item's failure never fails the whole request with a top-level
// error status, matching this codebase's own established bulk-route convention.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await generateReviewsForItems(actor, body, newRequestId());
  if (!result.ok) return toPartnerReviewsHttpResponse(result);
  return NextResponse.json(result.data, { status: 200 });
}
