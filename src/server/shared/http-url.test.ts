import { describe, expect, it } from "vitest";

import { isHttpUrl } from "./http-url";

describe("isHttpUrl", () => {
  it("accepts absolute http and https URLs", () => {
    expect(isHttpUrl("https://example.com/brief.pdf")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("https://sub.example.com:8443/a?b=c#d")).toBe(true);
  });

  it("rejects non-http(s) schemes, relative values, bare hosts and whitespace", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://example.com", "/relative/path", "example.com", "https://", "", "https://exa mple.com", " https://example.com", "https://example.com "]) {
      expect(isHttpUrl(bad)).toBe(false);
    }
  });
});
