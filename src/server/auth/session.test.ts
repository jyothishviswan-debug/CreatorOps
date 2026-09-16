import { afterEach, describe, expect, it, vi } from "vitest";

const { createSessionCookieMock, verifySessionCookieMock } = vi.hoisted(() => ({
  createSessionCookieMock: vi.fn(),
  verifySessionCookieMock: vi.fn(),
}));

vi.mock("@/server/firebase/admin", () => ({
  getAdminAuth: () => ({
    createSessionCookie: createSessionCookieMock,
    verifySessionCookie: verifySessionCookieMock,
  }),
}));

import {
  createSessionCookie,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  sessionCookieOptions,
  verifySessionCookie,
} from "./session";

afterEach(() => {
  vi.clearAllMocks();
});

describe("sessionCookieOptions", () => {
  it("is HttpOnly, SameSite=Lax, and scoped to the whole app", () => {
    const options = sessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.maxAge).toBe(SESSION_COOKIE_MAX_AGE_SECONDS);
  });

  it("accepts a custom max age", () => {
    expect(sessionCookieOptions(60).maxAge).toBe(60);
  });
});

describe("createSessionCookie", () => {
  it("exchanges the ID token for a session cookie with the expected lifetime", async () => {
    createSessionCookieMock.mockResolvedValue("the-session-cookie");

    const result = await createSessionCookie("the-id-token");

    expect(result).toBe("the-session-cookie");
    expect(createSessionCookieMock).toHaveBeenCalledWith("the-id-token", {
      expiresIn: SESSION_COOKIE_MAX_AGE_SECONDS * 1000,
    });
  });
});

describe("verifySessionCookie", () => {
  it("returns null when no cookie is given, without calling Firebase", async () => {
    const result = await verifySessionCookie(undefined);
    expect(result).toBeNull();
    expect(verifySessionCookieMock).not.toHaveBeenCalled();
  });

  it("returns the decoded token for a valid cookie, checking revocation", async () => {
    verifySessionCookieMock.mockResolvedValue({ uid: "user-1" });

    const result = await verifySessionCookie("a-cookie");

    expect(result).toEqual({ uid: "user-1" });
    expect(verifySessionCookieMock).toHaveBeenCalledWith("a-cookie", true);
  });

  it("resolves to null (never throws) for an invalid/expired/revoked cookie", async () => {
    verifySessionCookieMock.mockRejectedValue(new Error("invalid cookie"));

    await expect(verifySessionCookie("a-bad-cookie")).resolves.toBeNull();
  });
});
