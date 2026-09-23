import { NextResponse } from "next/server";

// Session/actor resolution and request-id generation are generic, not Invoices-specific - reused
// directly, same as Payables'/Finance Agreements'/Partner Reviews' own http.ts.
export { resolveRequestActor, newRequestId, parseJsonBody } from "@/server/administration/http";

import type { FinanceInvoicesServiceErrorCode, FinanceInvoicesServiceResult } from "./types";

// 401 (not authenticated) / 403 (feature, action, scope or sensitive denial - never says which,
// body is always {error:"Forbidden."}) / 404 / 400 / 409 (stale write, conflict, not ready with its
// blockers) / 500. Identical mapping to Payables' own.
export function toFinanceInvoicesHttpResponse<T>(result: FinanceInvoicesServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus });

  if (result.code === "unauthorized") {
    const status = result.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  if (result.code === "not_ready") {
    return NextResponse.json({ error: result.message, blockers: result.blockers ?? [] }, { status: 409 });
  }

  const statusByCode: Record<Exclude<FinanceInvoicesServiceErrorCode, "unauthorized" | "not_ready">, number> = {
    not_found: 404,
    invalid_input: 400,
    stale_write: 409,
    conflict: 409,
    internal: 500,
  };
  return NextResponse.json({ error: result.message }, { status: statusByCode[result.code] });
}

// A query-string integer for a route (`?version=2`, `?limit=20`). Absent => undefined.
export function optionalIntegerParam(searchParams: URLSearchParams, name: string): number | undefined {
  const raw = searchParams.get(name);
  if (raw === null) return undefined;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
}

// A query-string opaque value: absent => undefined, otherwise passed through verbatim for the
// service to validate.
export function optionalStringParam(searchParams: URLSearchParams, name: string): string | undefined {
  return searchParams.get(name) ?? undefined;
}
