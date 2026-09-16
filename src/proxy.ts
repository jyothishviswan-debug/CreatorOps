import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/server/auth/session";
import { resolveActor } from "@/server/authz/actor";
import { canAccessFeature } from "@/server/authz/capabilities";
import { getFeatureForPath } from "@/server/authz/features";

// Step 4B: full pipeline - Authentication, then Active User / Admission,
// then Feature Access, on every request to every gated route. Nothing
// here trusts client state; every stage re-reads from Firebase/Firestore
// (or the local emulator). Only the sign-in page itself and the session
// API are exempt from all of this.
const PUBLIC_PATHS = ["/sign-in"];
const ACCESS_DENIED_PATH = "/access-denied";

function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return true;
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  // Authentication: always re-verify against Firebase (or the local
  // emulator) - the mere presence of a cookie proves nothing on its own.
  const session = await verifySessionCookie(cookie);

  if (pathname === "/sign-in") {
    if (session) return NextResponse.redirect(new URL("/dashboard", request.url));
    return NextResponse.next();
  }

  if (isPublicPath(pathname)) return NextResponse.next();

  if (!session) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(signInUrl);
  }

  // Active User / Admission: being a valid Firebase identity doesn't
  // automatically mean admitted into the app - the users/{uid} profile
  // must exist, parse, and be active. A missing profile, a malformed
  // one, and an inactive one are all treated the same way on purpose:
  // bounced to sign-in exactly like "not authenticated", with the stale
  // session cookie cleared so the client stops presenting it.
  const actor = await resolveActor(session.uid);
  if (!actor) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("reason", "inactive");
    const response = NextResponse.redirect(signInUrl);
    response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
  }

  // /access-denied itself only needs a real, active actor - not a
  // feature grant (that would be circular).
  if (pathname === ACCESS_DENIED_PATH) return NextResponse.next();

  // Feature Access: explicit per-role grant, re-checked on every request,
  // never inferred from what the sidebar happens to show. Routes with no
  // feature mapping (e.g. /foundation) are gated by authentication alone.
  const feature = getFeatureForPath(pathname);
  if (feature) {
    const allowed = await canAccessFeature(actor, feature);
    if (!allowed) {
      const deniedUrl = new URL(ACCESS_DENIED_PATH, request.url);
      deniedUrl.searchParams.set("feature", feature);
      return NextResponse.redirect(deniedUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Excludes Next's own internals plus anything that looks like a static
  // file (has a dot in its last path segment - logo.png, favicon.ico,
  // *.svg, etc.) so public/ assets are never redirected to /sign-in. Every
  // real app route in this project is a clean, extension-less path.
  matcher: ["/((?!_next/static|_next/image|.*\\..*).*)"],
};
