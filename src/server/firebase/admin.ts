import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

import { getServerEnv, isUsingEmulators } from "@/lib/env/server";

export function getAdminApp() {
  if (getApps().length > 0) return getApps()[0]!;

  const env = getServerEnv();
  return initializeApp(
    isUsingEmulators()
      ? { projectId: env.projectId }
      : { credential: applicationDefault(), projectId: env.projectId },
  );
}

export function getAdminAuth() {
  return getAuth(getAdminApp());
}

export function getAdminFirestore() {
  return getFirestore(getAdminApp());
}
