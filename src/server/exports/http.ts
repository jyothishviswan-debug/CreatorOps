import { NextResponse } from "next/server";

// Session/actor resolution and request-id generation are generic, not Export-Center-specific -
// reused directly, same as Reports' own http.ts.
export { resolveRequestActor, newRequestId, parseJsonBody } from "@/server/administration/http";

import type { ExportsServiceErrorCode, ExportsServiceResult } from "./types";

// Same status mapping discipline as every other module's own toXHttpResponse - typed states, never a
// raw Firebase error reaching the client.
export function toExportsHttpResponse<T>(result: ExportsServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus });

  if (result.code === "unauthorized") {
    const status = result.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  const statusByCode: Record<Exclude<ExportsServiceErrorCode, "unauthorized">, number> = {
    not_found: 404,
    invalid_input: 400,
    unsupported: 501,
    source_unavailable: 424,
    size_exceeded: 409,
    internal: 500,
  };
  return NextResponse.json({ error: result.message }, { status: statusByCode[result.code] });
}
