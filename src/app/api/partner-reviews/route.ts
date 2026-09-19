import { NextResponse } from "next/server";

import { generatePartnerReviewDraft, listPartnerReviewHeads } from "@/server/partner-reviews/partner-review-service";
import type { PartnerReviewListCursor } from "@/server/partner-reviews/firestore";
import { newRequestId, parseJsonBody, resolveRequestActor, toPartnerReviewsHttpResponse } from "@/server/partner-reviews/http";
import { compoundListCursorSchema } from "@/server/shared/scoped-list";

// GET /api/partner-reviews?partnerRef=&periodKey=&status=&limit=&cursor= -
// scoped, bounded, cursor-paginated list of review heads. `cursor` is an
// opaque JSON-encoded compound cursor (see src/server/shared/scoped-list.ts);
// a malformed/tampered value is simply dropped, never trusted.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);

  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;

  let cursor: PartnerReviewListCursor | undefined;
  const cursorRaw = url.searchParams.get("cursor");
  if (cursorRaw) {
    try {
      const parsed = compoundListCursorSchema.safeParse(JSON.parse(cursorRaw));
      if (parsed.success) cursor = parsed.data;
    } catch {
      // Malformed JSON - fall through with no cursor.
    }
  }

  const result = await listPartnerReviewHeads(actor, {
    limit,
    cursor,
    partnerRef: url.searchParams.get("partnerRef") ?? undefined,
    periodKey: url.searchParams.get("periodKey") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
  });
  return toPartnerReviewsHttpResponse(result);
}

// POST /api/partner-reviews {partnerRef, periodKey} - generate the Draft
// (version 1) for one Partner + month. 201 when this call created the
// review, 200 when it already existed (idempotent retry); the same fact is
// sent as `X-Partner-Review-Outcome: created | existing`.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await generatePartnerReviewDraft(actor, body, newRequestId());
  if (!result.ok) return toPartnerReviewsHttpResponse(result);
  return NextResponse.json(result.data.review, { status: result.data.outcome === "created" ? 201 : 200, headers: { "X-Partner-Review-Outcome": result.data.outcome } });
}
