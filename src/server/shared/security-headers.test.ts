import { describe, expect, it } from "vitest";

import nextConfig from "../../../next.config";

// Production hardening (base spec section 10 - security headers): "Add automated header
// assertions." Exercises the real headers() function next.config.ts exports (not a re-implemented
// copy), so a future edit that silently drops or weakens a header fails this test, not just a
// manual curl check.
describe("next.config.ts headers()", () => {
  async function headerMap(source: string): Promise<Map<string, string>> {
    const groups = await nextConfig.headers!();
    const map = new Map<string, string>();
    for (const group of groups) {
      if (group.source !== source) continue;
      for (const header of group.headers) map.set(header.key, header.value);
    }
    return map;
  }

  it("sets the baseline hardening headers on every route", async () => {
    const headers = await headerMap("/:path*");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("Permissions-Policy")).toMatch(/camera=\(\)/);
    expect(headers.get("Permissions-Policy")).toMatch(/microphone=\(\)/);
    expect(headers.get("Permissions-Policy")).toMatch(/geolocation=\(\)/);
  });

  // Content-Security-Policy is deliberately NOT asserted here - it is not set by next.config.ts's
  // headers() at all (a static, config-level CSP cannot carry the per-request nonce Next's own
  // framework-injected inline scripts need - see next.config.ts's and src/proxy.ts's own comments
  // for the full mechanism/rationale). See proxy.test.ts's own CSP/nonce coverage instead.

  it("marks every /api/* response no-store - never cached with real user/business data", async () => {
    const headers = await headerMap("/api/:path*");
    expect(headers.get("Cache-Control")).toBe("no-store");
  });
});
