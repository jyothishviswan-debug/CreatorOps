import { z } from "zod";

const serverEnvSchema = z.object({
  projectId: z.string().min(1),
  authEmulatorHost: z.string().optional(),
  firestoreEmulatorHost: z.string().optional(),
  storageEmulatorHost: z.string().optional(),
  googleApplicationCredentials: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (!cached) {
    cached = serverEnvSchema.parse({
      projectId: process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST,
      firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
      storageEmulatorHost: process.env.FIREBASE_STORAGE_EMULATOR_HOST,
      googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    });
  }
  return cached;
}

export function isUsingEmulators(): boolean {
  const env = getServerEnv();
  return Boolean(env.authEmulatorHost || env.firestoreEmulatorHost || env.storageEmulatorHost);
}
