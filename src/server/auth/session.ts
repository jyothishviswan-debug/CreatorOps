import type { DecodedIdToken } from "firebase-admin/auth";

import { getAdminAuth } from "@/server/firebase/admin";

export const SESSION_COOKIE_NAME = "creatorops_session";

// Firebase session cookies support a maximum lifetime of 14 days; 5 is a
// reasonable default for this stage (sign-in/sign-out only, no refresh flow).
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 5;

export function sessionCookieOptions(maxAgeSeconds: number = SESSION_COOKIE_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

// Exchanges a freshly-obtained Firebase ID token for a long-lived, HttpOnly
// session cookie value. The ID token itself is short-lived and only ever
// touches the client; the session cookie is what the server trusts.
export async function createSessionCookie(idToken: string): Promise<string> {
  return getAdminAuth().createSessionCookie(idToken, {
    expiresIn: SESSION_COOKIE_MAX_AGE_SECONDS * 1000,
  });
}

// Verifies a session cookie against Firebase Auth (or the local emulator),
// checking the revocation list too. Never throws - a missing/invalid/
// expired/revoked cookie simply resolves to null so callers always take
// the "not signed in" path rather than trusting client state.
export async function verifySessionCookie(cookie: string | undefined): Promise<DecodedIdToken | null> {
  if (!cookie) return null;
  try {
    return await getAdminAuth().verifySessionCookie(cookie, true);
  } catch {
    return null;
  }
}
