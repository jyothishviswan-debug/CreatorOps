import { describe, expect, it } from "vitest";

import { isPublicPath } from "./proxy";

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
