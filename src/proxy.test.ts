import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCsp, isPublicPath } from "./proxy";

// Step 10C.1: focused coverage for the public-route boundary matcher -
// segment-aware by construction, so a path that merely begins with the
// same characters as a public entry (a prefix collision) must never be
// treated as public.
describe("isPublicPath", () => {
  it("treats every /api/* path as public", () => {
    expect(isPublicPath("/api/public/submissions/abc123")).toBe(true);
    expect(isPublicPath("/api/assignments")).toBe(true);
  });

  it("treats /sign-in and /submit exactly, and their real sub-paths, as public", () => {
    expect(isPublicPath("/sign-in")).toBe(true);
    expect(isPublicPath("/submit")).toBe(true);
    expect(isPublicPath("/submit/abc123")).toBe(true);
    expect(isPublicPath("/submit/anything-token-shaped")).toBe(true);
  });

  it("never treats a prefix-collision path as public", () => {
    expect(isPublicPath("/submit-admin")).toBe(false);
    expect(isPublicPath("/submitanything")).toBe(false);
    expect(isPublicPath("/submit-not-public")).toBe(false);
    expect(isPublicPath("/sign-in-fake")).toBe(false);
    expect(isPublicPath("/sign-inward")).toBe(false);
  });

  it("never treats an unrelated protected route as public", () => {
    expect(isPublicPath("/assignments")).toBe(false);
    expect(isPublicPath("/dashboard")).toBe(false);
  });
});

// Production hardening (base spec section 10 - security headers): the Content-Security-Policy the
// middleware generates per request. A real live-browser check (see the stage's own completion
// report / docs/PRODUCTION_HARDENING.md section 11) found an earlier, next.config.ts-only version
// of this CSP broke the app outright - Next's own framework-injected inline scripts (RSC payload
// embedding, hydration data) were blocked because that static CSP had no nonce, and a
// next.config.ts `headers()` entry can never carry one anyway (it only ever touches the outgoing
// response, never the request Next's own render pipeline reads the nonce from). These tests cover
// the actual policy-string logic; the nonce round-trip through a real request/response (and that
// Next's own scripts actually run under it) is covered by the same live-browser verification, not
// re-derivable from a pure unit test.
describe("buildCsp", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes the given nonce in script-src, alongside 'self' - script-src itself never carries 'unsafe-inline'", () => {
    const csp = buildCsp("abc123==");
    const scriptSrc = csp.split(";").find((directive) => directive.trim().startsWith("script-src"))!;
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'nonce-abc123=='");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("produces a different nonce token per call when given different input - the whole point of a per-request nonce", () => {
    expect(buildCsp("nonce-one")).not.toBe(buildCsp("nonce-two"));
  });

  it("carries 'unsafe-eval' outside production (Turbopack/Fast Refresh's own real eval() use - not solvable by a nonce) but never in production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(buildCsp("n")).toContain("'unsafe-eval'");

    vi.stubEnv("NODE_ENV", "production");
    expect(buildCsp("n")).not.toContain("'unsafe-eval'");
  });

  it("points connect-src at the real Firebase Auth endpoints in production, the local emulator origin otherwise", () => {
    vi.stubEnv("NODE_ENV", "production");
    const prodCsp = buildCsp("n");
    expect(prodCsp).toContain("https://identitytoolkit.googleapis.com");
    expect(prodCsp).toContain("https://securetoken.googleapis.com");
    expect(prodCsp).not.toContain("127.0.0.1");

    vi.stubEnv("NODE_ENV", "development");
    const devCsp = buildCsp("n");
    expect(devCsp).toContain("127.0.0.1");
    expect(devCsp).not.toContain("identitytoolkit.googleapis.com");
  });

  it("has the expected lockdown directives, and never a bare wildcard source", () => {
    const csp = buildCsp("n");
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/base-uri 'self'/);
    expect(csp).toMatch(/form-action 'self'/);
    // Never a bare `*` source token (as opposed to a scoped `http://127.0.0.1:*` port wildcard,
    // which the dev-mode connect-src directive intentionally uses).
    expect(csp).not.toMatch(/(^|\s)\*(?=[\s;]|$)/);
  });

  it("allows the Agreement/Invoice PDF preview iframe's own same-origin blob: URL, nothing broader", () => {
    // Found via a real Playwright run (finance-agreements-intake.spec.ts) after an earlier version
    // of this CSP shipped without it: SourceDocumentPane.tsx/DocumentTab.tsx/InvoiceDetailsStep.tsx
    // render an uploaded PDF preview in an <iframe src={URL.createObjectURL(file)}> - a same-origin
    // `blob:` URL - which `default-src 'self'` (frame-src's own fallback) blocks outright with no
    // explicit frame-src allowance.
    const csp = buildCsp("n");
    const frameSrc = csp.split(";").find((directive) => directive.trim().startsWith("frame-src"))!;
    expect(frameSrc).toBeDefined();
    expect(frameSrc).toContain("'self'");
    expect(frameSrc).toContain("blob:");
  });
});
