import type { NextConfig } from "next";

// Production hardening (base spec section 10 - security headers).
//
// Content-Security-Policy is NOT set here. A static, config-level CSP cannot carry a per-request
// nonce, and Next.js's own framework-injected inline <script> tags (RSC payload embedding,
// hydration data - confirmed by reading node_modules/next/dist/server/app-render/app-render.js:
// it reads a nonce straight out of the REQUEST's own `content-security-policy` header via
// getScriptNonceFromHeader and threads it into every script tag it generates) need that nonce to
// ever be allowed to run - completely independent of whether THIS APP'S OWN code injects an inline
// script (it doesn't; the earlier version of this comment checked only that and was wrong). A
// `script-src` with neither a nonce nor 'unsafe-inline' - what a next.config.ts-only CSP can ever
// produce - blocks Next's own bootstrap and breaks the app outright (found via a real live-browser
// check: `next dev`, navigate to /sign-in, real CSP console errors, sign-in never completes).
// src/proxy.ts generates a real per-request nonce, sets it on both the outgoing request (so Next's
// render pipeline reads it and nonces its own scripts) and the response (so the browser enforces
// it), and is the ONLY place the CSP header is set. See that file's own comment for the exact
// mechanism, and docs/PRODUCTION_HARDENING.md section 11 for the live-verification evidence.
const isProd = process.env.NODE_ENV === "production";

const SECURITY_HEADERS = [
  // Clickjacking: this app is never meant to be framed by anyone, including itself.
  { key: "X-Frame-Options", value: "DENY" },
  // Never let a browser MIME-sniff a response into executing as something it isn't.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Send the full origin to same-origin navigations/requests, only the origin (no path/query) cross-origin.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // No browser feature this app uses needs any of these; deny them all outright.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
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
