import { NextResponse } from "next/server";

// Session/actor resolution and request-id generation are generic, not Operations-specific - reused
// directly, same as every Finance module's own http.ts.
export { resolveRequestActor, newRequestId, parseJsonBody } from "@/server/administration/http";

import type { OperationsServiceErrorCode, OperationsServiceResult } from "./types";

// 401 (not authenticated) / 403 (feature, action or scope denial - never says which, body is always
// {error:"Forbidden."}) / 404 / 400 / 409 (stale write, conflict, not ready with its blockers) /
// 500. Identical mapping to every Finance module's own toXHttpResponse.
export function toOperationsHttpResponse<T>(result: OperationsServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus });

  if (result.code === "unauthorized") {
    const status = result.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  if (result.code === "not_ready") {
    return NextResponse.json({ error: result.message, blockers: result.blockers ?? [] }, { status: 409 });
  }

  const statusByCode: Record<Exclude<OperationsServiceErrorCode, "unauthorized" | "not_ready">, number> = {
    not_found: 404,
    invalid_input: 400,
    stale_write: 409,
    conflict: 409,
    internal: 500,
  };
  return NextResponse.json({ error: result.message }, { status: statusByCode[result.code] });
}

export function optionalIntegerParam(searchParams: URLSearchParams, name: string): number | undefined {
  const raw = searchParams.get(name);
  if (raw === null) return undefined;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
}

export function optionalStringParam(searchParams: URLSearchParams, name: string): string | undefined {
  return searchParams.get(name) ?? undefined;
}

export function optionalBooleanParam(searchParams: URLSearchParams, name: string): boolean | undefined {
  const raw = searchParams.get(name);
  if (raw === null) return undefined;
  return raw === "true";
}
