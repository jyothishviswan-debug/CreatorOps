import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";

import { getFirebaseApp } from "@/lib/firebase/client";
import { getClientEnv } from "@/lib/env/client";

let auth: Auth | undefined;
let emulatorConnected = false;

export function getFirebaseAuth(): Auth {
  if (!auth) {
    auth = getAuth(getFirebaseApp());
  }

  const env = getClientEnv();
  if (env.useEmulators && !emulatorConnected) {
    // Default: the shared local Auth emulator. A PRIVATE emulator (private test runs that must not touch the shared 9099 one)
    // sets NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL, e.g. http://127.0.0.1:9499 (referenced statically so Next inlines it).
    connectAuthEmulator(auth, process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL ?? "http://127.0.0.1:9099", { disableWarnings: true });
    emulatorConnected = true;
  }

  return auth;
}
