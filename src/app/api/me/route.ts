import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/server/auth/session";
import { resolveActor } from "@/server/authz/actor";
import { toClientDto } from "@/server/authz/client-dto";

// The only authorization data ever handed to the browser: a safe DTO
// (role, displayName, the flat list of feature ids the actor can view)
// used purely for presentation - nav filtering, the sidebar's identity
// line. Never trusted for enforcement; proxy.ts independently re-checks
// every protected route server-side regardless of what this returns.
export async function GET() {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionCookie(cookie);
  if (!session) return NextResponse.json({ authenticated: false });

  const actor = await resolveActor(session.uid);
  if (!actor) return NextResponse.json({ authenticated: false });

  return NextResponse.json(await toClientDto(actor));
}
