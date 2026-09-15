import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";

import { getClientEnv } from "@/lib/env/client";

export function getFirebaseApp(): FirebaseApp {
  if (getApps().length > 0) return getApp();

  const env = getClientEnv();
  return initializeApp({
    apiKey: env.apiKey,
    authDomain: env.authDomain,
    projectId: env.projectId,
    storageBucket: env.storageBucket,
    messagingSenderId: env.messagingSenderId,
    appId: env.appId,
  });
}
