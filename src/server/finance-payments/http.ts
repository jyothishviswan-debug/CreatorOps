import { NextResponse } from "next/server";

// Session/actor resolution and request-id generation are generic, not Payments-specific - reused
// directly, same as Finance Invoices'/Payables' own http.ts.
export { resolveRequestActor, newRequestId, parseJsonBody } from "@/server/administration/http";

import type { FinancePaymentsServiceErrorCode, FinancePaymentsServiceResult } from "./types";

// 401 (not authenticated) / 403 (feature, action, scope or sensitive denial - never says which,
// body is always {error:"Forbidden."}) / 404 / 400 / 409 (stale write, conflict, not ready with
// its blockers) / 500. Identical mapping to the Finance Invoices/Payables one.
export function toFinancePaymentsHttpResponse<T>(result: FinancePaymentsServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus });

  if (result.code === "unauthorized") {
    const status = result.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  if (result.code === "not_ready") {
    return NextResponse.json({ error: result.message, blockers: result.blockers ?? [] }, { status: 409 });
  }

  const statusByCode: Record<Exclude<FinancePaymentsServiceErrorCode, "unauthorized" | "not_ready">, number> = {
    not_found: 404,
    invalid_input: 400,
    stale_write: 409,
    conflict: 409,
    internal: 500,
  };
  return NextResponse.json({ error: result.message }, { status: statusByCode[result.code] });
}

// A query-string integer for a route (`?version=2`, `?limit=20`). Absent => undefined (the service
// applies its default). Anything present but not a plain non-negative integer string becomes NaN,
// which the service's own strict input schema rejects as invalid_input (400) - the route never
// interprets, clamps or repairs it.
export function optionalIntegerParam(searchParams: URLSearchParams, name: string): number | undefined {
  const raw = searchParams.get(name);
  if (raw === null) return undefined;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
}

// A query-string opaque value: absent => undefined, otherwise passed through verbatim for the
// service to validate (a forged / malformed value is the service's neutral answer).
export function optionalStringParam(searchParams: URLSearchParams, name: string): string | undefined {
  return searchParams.get(name) ?? undefined;
}
