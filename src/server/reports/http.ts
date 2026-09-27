import { NextResponse } from "next/server";

// Session/actor resolution and request-id generation are generic, not Reports-specific - reused
// directly, same as every Operations/Finance module's own http.ts.
export { resolveRequestActor, newRequestId, parseJsonBody } from "@/server/administration/http";

import type { ReportLifecycleErrorCode, ReportLifecycleResult, ReportsServiceErrorCode, ReportsServiceResult } from "./types";

// 401 (not authenticated) / 403 (feature, action or scope denial - never says which, body is always
// {error:"Forbidden."}) / 404 / 400 / 409 (size/bound exceeded) / 424 (source unavailable) / 501
// (unsupported report) / 500. Same mapping discipline as every other module's own toXHttpResponse -
// typed states, never a raw Firebase error reaching the client (section 20).
export function toReportsHttpResponse<T>(result: ReportsServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus });

  if (result.code === "unauthorized") {
    const status = result.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  const statusByCode: Record<Exclude<ReportsServiceErrorCode, "unauthorized">, number> = {
    not_found: 404,
    invalid_input: 400,
    unsupported: 501,
    source_unavailable: 424,
    size_exceeded: 409,
    internal: 500,
  };
  return NextResponse.json({ error: result.message }, { status: statusByCode[result.code] });
}

// Reports Final-Master: the lifecycle service's own result shape (unauthorized/not_found/
// invalid_input/stale/conflict/internal) - a genuinely different error vocabulary from
// ReportsServiceResult above (no "unsupported"/"source_unavailable"/"size_exceeded" concept applies to
// a lifecycle mutation; "stale"/"conflict" do not apply to a plain report run). Kept as its own mapper
// rather than force-fitting one union onto both.
export function toReportLifecycleHttpResponse<T>(result: ReportLifecycleResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus });

  if (result.code === "unauthorized") {
    const status = result.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }
  const statusByCode: Record<Exclude<ReportLifecycleErrorCode, "unauthorized">, number> = {
    not_found: 404,
    invalid_input: 400,
    stale: 409,
    conflict: 409,
    internal: 500,
  };
  return NextResponse.json({ error: result.message }, { status: statusByCode[result.code] });
}
