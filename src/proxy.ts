import { randomBytes } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/server/auth/session";
import { resolveActor } from "@/server/authz/actor";
import { canAccessFeature } from "@/server/authz/capabilities";
import { getFeatureForPath } from "@/server/authz/features";

// Step 4B: full pipeline - Authentication, then Active User / Admission,
// then Feature Access, on every request to every gated route. Nothing
// here trusts client state; every stage re-reads from Firebase/Firestore
// (or the local emulator). Only the sign-in page itself, the session API,
// and the Step 10C public token-scoped submission page are exempt from
// all of this - /submit/[token] is deliberately outside the authenticated
// CreatorOps workspace; the bearer token in its own URL is its sole
// authorization primitive, verified server-side (never a CreatorOps
// session). No other route is affected by this exemption.
const PUBLIC_PATHS = ["/sign-in", "/submit"];
const ACCESS_DENIED_PATH = "/access-denied";

// Step 10C.1: exact/segment-aware by construction - a path is public only
// when it equals a PUBLIC_PATHS entry exactly, or starts with that entry
// PLUS a "/" separator. A prefix-collision path that merely begins with
// the same characters (e.g. "/submit-admin", "/submitanything") never
// matches either branch, since neither "===" nor a "/"-suffixed
// startsWith can be satisfied by a same-prefix-different-next-character
// string. Exported for direct unit coverage (see proxy.test.ts) - the
// pure part of this module, with no Next.js/Firebase dependency.
export function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return true;
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

// Production hardening (base spec section 10 - security headers): the Content-Security-Policy
// header, generated fresh per request with a real random nonce - the ONLY place in this codebase
// the CSP header is set (next.config.ts's own `headers()` deliberately does not carry it; see that
// file's comment for why a static, config-level CSP cannot support this).
//
// Why a nonce, and why it has to be set on the REQUEST (not just the response): Next.js's own
// framework-injected inline <script> tags (RSC payload embedding, hydration data) need to be
// allowed to run under this policy - completely independent of whether this app's OWN code ever
// injects an inline script (it doesn't - grep confirms the one `dangerouslySetInnerHTML` in the
// whole codebase, src/ui/icons.tsx, renders SVG path data into an <svg>, never a <script>).
// node_modules/next/dist/server/app-render/app-render.js's own `parseRequestHeaders` reads
// `headers['content-security-policy']` straight off the INCOMING REQUEST and extracts a nonce from
// it (`getScriptNonceFromHeader`, matching the literal `'nonce-<value>'` source token), then threads
// that nonce into every inline script tag Next itself generates while rendering. A next.config.ts
// `headers()` entry only ever touches the OUTGOING RESPONSE, so it can never reach this mechanism -
// which is exactly the real, live-browser-confirmed defect an earlier version of this CSP had
// ('script-src' with neither a nonce nor 'unsafe-inline' blocked Next's own bootstrap outright, and
// the app never rendered). This is Next's own documented CSP pattern (nonce generated in
// middleware, propagated via the request), not a bespoke workaround.
export function buildCsp(nonce: string): string {
  const isProd = process.env.NODE_ENV === "production";
  // connect-src: 'self' for the app's own API routes, plus Firebase Auth's real endpoints in
  // production - the ONLY Firebase client SDK surface this app ever calls from the browser (see
  // src/lib/firebase/auth.ts's own comment: Firestore/Storage are read exclusively through the
  // trusted Admin SDK, server-side - grep confirms no `firebase/firestore` or `firebase/storage`
  // client import anywhere in src/). In non-production (emulator-backed dev/test), the local Auth
  // emulator origin is additionally allowed - never reachable in a production build.
  const authConnectSrc = isProd
    ? "https://identitytoolkit.googleapis.com https://securetoken.googleapis.com"
    : "http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*";
  // 'unsafe-eval' stays outside production only - Next's own dev-mode Fast Refresh/Turbopack HMR
  // client uses real `eval()` for module execution, a completely different mechanism from inline
  // <script> tags (which the nonce alone covers) and not solvable by a nonce.
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${isProd ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${authConnectSrc}`,
    // frame-src: the Agreement/Invoice document preview panes render an uploaded PDF in an
    // <iframe> via a `blob:` object URL (URL.createObjectURL - see
    // SourceDocumentPane.tsx/DocumentTab.tsx/InvoiceDetailsStep.tsx), same-origin-only, never a
    // remote src. Found via a real Playwright run against this CSP (finance-agreements-
    // intake.spec.ts's own "no console errors" assertion caught it immediately) - without this,
    // `default-src 'self'` is the fallback for frame-src and blocks the blob: preview outright.
    "frame-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

export async function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const csp = buildCsp(nonce);

  // Every response this middleware can produce carries the SAME CSP (this request's own nonce).
  // `toNext` is used for every "continue rendering" branch: it sets the nonce/CSP on the outgoing
  // REQUEST (propagated into the render pipeline Next uses for this same request, per this file's
  // own comment above) as well as the response. `toRedirect` only needs the response header - a
  // redirect has no rendered body, so no nonce is ever consumed for it.
  function toNext(): NextResponse {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", csp);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("Content-Security-Policy", csp);
    return response;
  }

  function toRedirect(url: URL): NextResponse {
    const response = NextResponse.redirect(url);
    response.headers.set("Content-Security-Policy", csp);
    return response;
  }

  const { pathname } = request.nextUrl;
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  // Authentication: always re-verify against Firebase (or the local
  // emulator) - the mere presence of a cookie proves nothing on its own.
  const session = await verifySessionCookie(cookie);

  if (pathname === "/sign-in") {
    if (session) return toRedirect(new URL("/dashboard", request.url));
    return toNext();
  }

  if (isPublicPath(pathname)) return toNext();

  if (!session) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("redirect", pathname);
    return toRedirect(signInUrl);
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
    const response = toRedirect(signInUrl);
    response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
  }

  // /access-denied itself only needs a real, active actor - not a
  // feature grant (that would be circular).
  if (pathname === ACCESS_DENIED_PATH) return toNext();

  // Feature Access: explicit per-role grant, re-checked on every request,
  // never inferred from what the sidebar happens to show. Routes with no
  // feature mapping (e.g. /foundation) are gated by authentication alone.
  const feature = getFeatureForPath(pathname);
  if (feature) {
    const allowed = await canAccessFeature(actor, feature);
    if (!allowed) {
      const deniedUrl = new URL(ACCESS_DENIED_PATH, request.url);
      deniedUrl.searchParams.set("feature", feature);
      return toRedirect(deniedUrl);
    }
  }

  return toNext();
}

export const config = {
  // Excludes Next's own internals plus anything that looks like a static
  // file (has a dot in its last path segment - logo.png, favicon.ico,
  // *.svg, etc.) so public/ assets are never redirected to /sign-in. Every
  // real app route in this project is a clean, extension-less path.
  matcher: ["/((?!_next/static|_next/image|.*\\..*).*)"],
};
