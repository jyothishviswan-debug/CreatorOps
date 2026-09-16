import { signOut as firebaseSignOut } from "firebase/auth";

import { getFirebaseAuth } from "@/lib/firebase/auth";

// Clears the server-trusted HttpOnly session cookie first (that's the
// source of truth for every protected route), then best-effort signs the
// client Firebase SDK out too. Never throws - the caller always proceeds
// to redirect to /sign-in regardless of network hiccups.
export async function signOutEverywhere(): Promise<void> {
  try {
    await fetch("/api/session", { method: "DELETE" });
  } catch {
    // Ignore - the client-side sign-out below still runs, and the
    // destination /sign-in redirect happens unconditionally either way.
  }
  await firebaseSignOut(getFirebaseAuth()).catch(() => undefined);
}
