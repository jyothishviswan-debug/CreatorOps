import { NextResponse } from "next/server";

// Session/actor resolution and request-id generation are generic, not
// Partner-Reviews-specific - reused directly, same as Assignments'/
// Campaigns'/Partners' own http.ts.
export { resolveRequestActor, newRequestId, parseJsonBody } from "@/server/administration/http";

import type { PartnerReviewsServiceErrorCode, PartnerReviewsServiceResult } from "./types";

// 401 (not authenticated) / 403 (feature, action or scope denied - never
// says which) / 404 / 400 / 409 (stale write, conflict, not ready).
export function toPartnerReviewsHttpResponse<T>(result: PartnerReviewsServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus });

  if (result.code === "unauthorized") {
    const status = result.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  if (result.code === "not_ready") {
    return NextResponse.json({ error: result.message, blockers: result.blockers ?? [] }, { status: 409 });
  }

  const statusByCode: Record<Exclude<PartnerReviewsServiceErrorCode, "unauthorized" | "not_ready">, number> = {
    not_found: 404,
    invalid_input: 400,
    stale_write: 409,
    conflict: 409,
    internal: 500,
  };
  return NextResponse.json({ error: result.message }, { status: statusByCode[result.code] });
}
