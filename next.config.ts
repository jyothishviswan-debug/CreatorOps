import type { NextConfig } from "next";

// Production hardening (base spec section 10 - security headers).
//
// CSP connect-src: 'self' for the app's own API routes, plus Firebase Auth's real endpoints in
// production - the ONLY Firebase client SDK surface this app ever calls from the browser (see
// src/lib/firebase/auth.ts's own comment: Firestore/Storage are read exclusively through the
// trusted Admin SDK, server-side - grep confirms no `firebase/firestore` or `firebase/storage`
// client import anywhere in src/). In non-production (emulator-backed dev/test), the local Auth
// emulator origin is additionally allowed - never reachable in a production build, since `isProd`
// is read once at server-start from NODE_ENV, the same signal Next.js's own build/start already
// authoritatively sets.
const isProd = process.env.NODE_ENV === "production";

const authConnectSrc = isProd
  ? "https://identitytoolkit.googleapis.com https://securetoken.googleapis.com"
  : "http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*";

// script-src carries 'unsafe-eval' ONLY outside production (Next's own dev-mode Fast
// Refresh/HMR client needs it). style-src keeps 'unsafe-inline': Next.js/React inject component
// styles as inline <style> tags by design; there is no inline <script> requirement (grep confirms
// no dangerouslySetInnerHTML script injection anywhere in src/), so script-src stays nonce-free and
// 'unsafe-inline'-free.
//
// NOT live-verified in a real browser against a running app + Auth emulator in this stage (an
// attempt to do so via the preview/browser tooling was aborted after it resolved a relative path
// against the MAIN checkout instead of this worktree, per its own comment in the continuity doc /
// completion report - see there for the full account and the cleanup this stage could not safely
// self-perform). This CSP is reasoned from actual source (src/lib/firebase/auth.ts's own comment:
// the only client-side Firebase SDK surface is Auth; grep confirms zero `firebase/firestore` /
// `firebase/storage` client imports anywhere in src/) rather than guessed, but a real cross-browser
// sign-in-to-dashboard walkthrough against a running instance is explicitly STAGING VERIFICATION
// REQUIRED, not claimed done here.
const CSP = [
  "default-src 'self'",
  `script-src 'self'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src 'self' ${authConnectSrc}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = [
  // Clickjacking: this app is never meant to be framed by anyone, including itself.
  { key: "X-Frame-Options", value: "DENY" },
  // Never let a browser MIME-sniff a response into executing as something it isn't.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Send the full origin to same-origin navigations/requests, only the origin (no path/query) cross-origin.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // No browser feature this app uses needs any of these; deny them all outright.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  { key: "Content-Security-Policy", value: CSP },
];

const nextConfig: NextConfig = {
  // OCR Completion stage: @napi-rs/canvas ships a native (.node) binding loaded via a plain
  // require() (js-binding.js) - Turbopack/webpack cannot bundle that into a Server Component / API
  // route chunk ("non-ecmascript placeable asset"). tesseract.js's own worker spawning has the same
  // shape (it resolves tesseract.js-core's WASM build via require() at runtime). Both must be left
  // as real Node `require()` calls at runtime rather than bundled - this is exactly what
  // serverExternalPackages is for. Verified: `next build` fails without this, succeeds with it.
  serverExternalPackages: ["@napi-rs/canvas", "tesseract.js", "tesseract.js-core"],
  experimental: {
    // Step 14A contract upload (POST /api/finance/contracts/upload, multipart PDF <= 10 MB).
    // src/proxy.ts matches every /api/* path, and while a proxy is present Next buffers each request
    // body in memory and TRUNCATES it at this limit WITHOUT failing the request (default 10 MB =
    // 10485760 bytes). A 10 MB PDF plus multipart framing is a few hundred bytes over that default, so
    // the body would arrive cut short (a corrupt PDF / an unterminated multipart). 11 MB leaves
    // headroom for the framing; the upload route itself rejects anything over 10 MB + 64 KB
    // (src/server/finance-agreements/upload-request.ts), which must stay below this value.
    // It also raises the (in-memory) buffer for every other /api/* request body from 10 MB to 11 MB.
    proxyClientMaxBodySize: "11mb",
  },
  async headers() {
    return [
      // Every response gets the baseline hardening set.
      { source: "/:path*", headers: SECURITY_HEADERS },
      // HSTS is meaningless (and browser-ignored) over plain HTTP - added only for a real HTTPS
      // deployment, never in local/emulator dev, so it can never accidentally pin a dev origin.
      ...(isProd ? [{ source: "/:path*", headers: [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] }] : []),
      // Every authenticated API response carries real user/business data - never cached by a
      // shared/browser cache. The session/sign-in endpoints are already under /api/ and covered by
      // this same rule (base spec section 33's cache/privacy review).
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
