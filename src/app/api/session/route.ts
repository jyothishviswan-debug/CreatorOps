import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { createSessionCookie, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/server/auth/session";

// Trusted server-side session boundary: the client only ever hands us a
// short-lived Firebase ID token (obtained after a successful client sign-in
// against the Auth emulator); this endpoint verifies it and mints the
// HttpOnly session cookie that every protected route actually trusts.
export async function POST(request: Request) {
  let idToken: unknown;
  try {
    ({ idToken } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof idToken !== "string" || idToken.length === 0) {
    return NextResponse.json({ error: "Missing ID token." }, { status: 400 });
  }

  try {
    const sessionCookie = await createSessionCookie(idToken);
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, sessionCookie, sessionCookieOptions());
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not establish a session." }, { status: 401 });
  }
}

export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
  return NextResponse.json({ ok: true });
}
