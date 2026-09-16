import { NextResponse } from "next/server";

import { createUser, listUsers } from "@/server/administration/users-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toHttpResponse } from "@/server/administration/http";

// GET /api/administration/users?limit=&cursor=&role=&active=&emailPrefix=
export async function GET(request: Request) {
  const actor = await resolveRequestActor();

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const cursorEmail = url.searchParams.get("cursorEmail");
  const cursorUserRef = url.searchParams.get("cursorUserRef");
  const role = url.searchParams.get("role");
  const activeParam = url.searchParams.get("active");
  const emailPrefix = url.searchParams.get("emailPrefix");

  const input = {
    limit: limitParam ? Number(limitParam) : undefined,
    cursor: cursorEmail && cursorUserRef ? { email: cursorEmail, userRef: cursorUserRef } : undefined,
    role: role ?? undefined,
    active: activeParam === null ? undefined : activeParam === "true",
    emailPrefix: emailPrefix ?? undefined,
  };

  const result = await listUsers(actor, input);
  return toHttpResponse(result);
}

// POST /api/administration/users - create/provision a development user.
// Idempotent by email: retrying with the same email is safe.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createUser(actor, body, newRequestId());
  return toHttpResponse(result, 201);
}
