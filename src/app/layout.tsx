import { headers } from "next/headers";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import "@/ui/foundation.css";
import "@/ui/overview.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "CreatorOps",
  description: "CreatorOps partnership workspace",
};

// Production hardening (base spec section 10 - security headers): reading `headers()` here is
// load-bearing, not decorative. src/proxy.ts sets a real Content-Security-Policy with a fresh
// per-request nonce on every response, and Next's own framework-injected inline scripts (RSC
// payload embedding, hydration data) automatically pick that nonce up from the request - but ONLY
// for a DYNAMICALLY rendered response. A route Next can statically prerender (this app has several
// - /sign-in among them, confirmed by `next build`'s own "○" static marker) is rendered ONCE at
// build time, before any request (and therefore any nonce) exists; the cached HTML's own inline
// scripts then carry no nonce at all, while every subsequent response's CSP header demands one -
// a real, live-browser-confirmed mismatch ("Executing inline script violates... nonce-...") this
// exact stage found and is fixing here, not a hypothetical.
//
// `headers()` is one of Next's own documented dynamic APIs: using it anywhere in a layout forces
// EVERY route under that layout - the entire app, since this is the root layout - out of static
// generation and into per-request dynamic rendering, which is exactly what guarantees the nonce
// baked into each page's HTML always matches that same response's own CSP header. This is Next's
// own documented pattern for combining a nonce-based CSP with the App Router (not a workaround);
// the returned value isn't otherwise consumed - forcing dynamic rendering is the entire point of
// the read.
export default async function RootLayout({ children }: LayoutProps<"/">) {
  await headers();

  return (
    <html lang="en" className={inter.className}>
      <body>{children}</body>
    </html>
  );
}
