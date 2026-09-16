import { describe, expect, it } from "vitest";

import { getSafeRedirectPath } from "./redirect";

describe("getSafeRedirectPath", () => {
  it("accepts a plain same-origin path", () => {
    expect(getSafeRedirectPath("/finance")).toBe("/finance");
    expect(getSafeRedirectPath("/discovery/leads")).toBe("/discovery/leads");
  });

  it("falls back for a missing candidate", () => {
    expect(getSafeRedirectPath(null)).toBe("/dashboard");
    expect(getSafeRedirectPath(undefined)).toBe("/dashboard");
    expect(getSafeRedirectPath("")).toBe("/dashboard");
  });

  it("rejects protocol-relative URLs", () => {
    expect(getSafeRedirectPath("//evil.example")).toBe("/dashboard");
  });

  it("rejects absolute URLs with a scheme", () => {
    expect(getSafeRedirectPath("https://evil.example")).toBe("/dashboard");
    expect(getSafeRedirectPath("/redirect?to=javascript://evil")).toBe("/dashboard");
  });

  it("rejects paths that don't start with a slash", () => {
    expect(getSafeRedirectPath("dashboard")).toBe("/dashboard");
  });

  it("rejects a redirect back to /sign-in to avoid a loop", () => {
    expect(getSafeRedirectPath("/sign-in")).toBe("/dashboard");
    expect(getSafeRedirectPath("/sign-in/")).toBe("/dashboard");
    expect(getSafeRedirectPath("/sign-in?redirect=/finance")).toBe("/dashboard");
  });

  it("honors a custom fallback", () => {
    expect(getSafeRedirectPath("//evil.example", "/foundation")).toBe("/foundation");
  });
});
