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
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    emulatorConnected = true;
  }

  return auth;
}
