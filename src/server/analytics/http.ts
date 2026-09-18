import { NextResponse } from "next/server";

// Session/actor resolution and request-id generation are generic, not
// Analytics-specific - reused directly, same as Content's/Assignments'/
// Campaigns'/Vendors'/Partners' own http.ts.
export { resolveRequestActor, newRequestId, parseJsonBody } from "@/server/administration/http";

import type { AnalyticsServiceErrorCode, AnalyticsServiceResult } from "./types";

export function toAnalyticsHttpResponse<T>(result: AnalyticsServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus });

  if (result.code === "unauthorized") {
    const status = result.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  const statusByCode: Record<Exclude<AnalyticsServiceErrorCode, "unauthorized">, number> = {
    not_found: 404,
    invalid_input: 400,
    stale_write: 409,
    conflict: 409,
    internal: 500,
  };
  return NextResponse.json({ error: result.message }, { status: statusByCode[result.code] });
}
