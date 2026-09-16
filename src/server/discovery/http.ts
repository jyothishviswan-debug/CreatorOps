import { NextResponse } from "next/server";

// Session/actor resolution and request-id generation are identical to
// Administration's (see src/server/administration/http.ts) - genuinely
// generic, not Administration-specific - so they're reused directly
// rather than duplicated here.
export { resolveRequestActor, newRequestId, parseJsonBody } from "@/server/administration/http";

import type { DiscoveryServiceErrorCode, DiscoveryServiceResult } from "./types";

export function toDiscoveryHttpResponse<T>(result: DiscoveryServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus });

  if (result.code === "unauthorized") {
    const status = result.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  if (result.code === "not_ready") {
    return NextResponse.json({ error: result.message, blockers: result.blockers ?? [] }, { status: 409 });
  }

  const statusByCode: Record<Exclude<DiscoveryServiceErrorCode, "unauthorized" | "not_ready">, number> = {
    not_found: 404,
    invalid_input: 400,
    stale_write: 409,
    conflict: 409,
    internal: 500,
  };
  return NextResponse.json({ error: result.message }, { status: statusByCode[result.code] });
}
