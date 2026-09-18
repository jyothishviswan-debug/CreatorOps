import { NextResponse } from "next/server";

// Session/actor resolution and request-id generation are generic, not
// Assignments-specific - reused directly, same as Campaigns'/Vendors'/
// Partners' own http.ts. NEVER imported by the public external-submission
// routes (src/app/api/public/submissions/**) - those are deliberately
// unauthenticated, the bearer token is their sole authorization primitive.
export { resolveRequestActor, newRequestId, parseJsonBody } from "@/server/administration/http";

import type { AssignmentsServiceErrorCode, AssignmentsServiceResult } from "./types";

export function toAssignmentsHttpResponse<T>(result: AssignmentsServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus });

  if (result.code === "unauthorized") {
    const status = result.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  if (result.code === "not_ready") {
    return NextResponse.json({ error: result.message, blockers: result.blockers ?? [] }, { status: 409 });
  }

  const statusByCode: Record<Exclude<AssignmentsServiceErrorCode, "unauthorized" | "not_ready">, number> = {
    not_found: 404,
    invalid_input: 400,
    stale_write: 409,
    conflict: 409,
    internal: 500,
  };
  return NextResponse.json({ error: result.message }, { status: statusByCode[result.code] });
}
