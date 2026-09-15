import { z } from "zod";

const clientEnvSchema = z.object({
  apiKey: z.string().min(1),
  authDomain: z.string().min(1),
  projectId: z.string().min(1),
  storageBucket: z.string().min(1),
  messagingSenderId: z.string().min(1),
  appId: z.string().min(1),
  useEmulators: z.boolean(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

let cached: ClientEnv | undefined;

export function getClientEnv(): ClientEnv {
  if (!cached) {
    cached = clientEnvSchema.parse({
      apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
      useEmulators: process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true",
    });
  }
  return cached;
}
