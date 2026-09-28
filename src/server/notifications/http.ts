import { NextResponse } from "next/server";

// Session/actor resolution and request-id generation are generic, not Notifications-specific -
// reused directly, same as every other domain's own http.ts (see
// src/server/administration/http.ts's own comment).
export { resolveRequestActor, newRequestId, parseJsonBody } from "@/server/administration/http";

import type { NotificationsServiceErrorCode, NotificationsServiceResult } from "./types";

export function toNotificationsHttpResponse<T>(result: NotificationsServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus });

  if (result.code === "unauthorized") {
    const status = result.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  const statusByCode: Record<Exclude<NotificationsServiceErrorCode, "unauthorized">, number> = {
    not_found: 404,
    invalid_input: 400,
    conflict: 409,
    internal: 500,
  };
  return NextResponse.json({ error: result.message }, { status: statusByCode[result.code] });
}
