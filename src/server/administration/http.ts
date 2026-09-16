import { randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/server/auth/session";
import { resolveActor } from "@/server/authz/actor";
import type { ActorContext } from "@/server/authz/types";
import type { ServiceErrorCode, ServiceResult } from "./types";

// Every Administration route resolves the caller's own actor the same
// way - never trusting anything the request body/query claims about who
// is asking.
export async function resolveRequestActor(): Promise<ActorContext | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionCookie(cookie);
  if (!session) return null;
  return resolveActor(session.uid);
}

export function newRequestId(): string {
  return randomUUID();
}

export function toHttpResponse<T>(result: ServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus });

  if (result.code === "unauthorized") {
    // Not authenticated at all => 401; authenticated but denied by any of
    // the feature/action/scope/admission checks => 403. Either way the
    // response body never says *which* layer failed beyond this.
    const status = result.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  const statusByCode: Record<Exclude<ServiceErrorCode, "unauthorized">, number> = {
    not_found: 404,
    invalid_input: 400,
    stale_write: 409,
    conflict: 409,
    internal: 500,
  };
  return NextResponse.json({ error: result.message }, { status: statusByCode[result.code] });
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
