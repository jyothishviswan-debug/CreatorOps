import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/server/auth/session";

// Step 4A: authentication means "signed in or signed out" only - no
// role/scope checks yet. Every app-shell route requires a verified
// session; only the sign-in page itself and the session API are public.
const PUBLIC_PATHS = ["/sign-in"];

function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return true;
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  // Always re-verify against Firebase (or the local emulator) - the mere
  // presence of a cookie proves nothing on its own.
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

  return NextResponse.next();
}

export const config = {
  // Excludes Next's own internals plus anything that looks like a static
  // file (has a dot in its last path segment - logo.png, favicon.ico,
  // *.svg, etc.) so public/ assets are never redirected to /sign-in. Every
  // real app route in this project is a clean, extension-less path.
  matcher: ["/((?!_next/static|_next/image|.*\\..*).*)"],
};
