import { NextResponse } from "next/server";

export { resolveRequestActor, newRequestId, parseJsonBody } from "@/server/administration/http";

import type { NotesMeetingsServiceErrorCode, NotesMeetingsServiceResult } from "./types";

// Notes/Meetings Completion: identical HTTP mapping to every other module's own toXHttpResponse
// (Operations/Finance) - 401 (not authenticated) / 403 (feature/action/owner denial - body is always
// {error:"Forbidden."}, never says which) / 404 / 400 / 409 (stale write, conflict) / 500.
export function toNotesMeetingsHttpResponse<T>(result: NotesMeetingsServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus });

  if (result.code === "unauthorized") {
    const status = result.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  const statusByCode: Record<Exclude<NotesMeetingsServiceErrorCode, "unauthorized">, number> = {
    not_found: 404,
    invalid_input: 400,
    stale_write: 409,
    conflict: 409,
    internal: 500,
  };
  return NextResponse.json({ error: result.message }, { status: statusByCode[result.code] });
}

export function optionalStringParam(searchParams: URLSearchParams, name: string): string | undefined {
  return searchParams.get(name) ?? undefined;
}

export function optionalIntegerParam(searchParams: URLSearchParams, name: string): number | undefined {
  const raw = searchParams.get(name);
  if (raw === null) return undefined;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
}
