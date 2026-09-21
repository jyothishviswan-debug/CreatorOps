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

// Step 14B.1: durable Agreement-document storage (Google Drive) configuration. Read straight from the
// environment on every call (uncached, and independent of the Firebase project id, so a process that has
// no Firebase configuration can still answer "Drive storage not configured" truthfully).
//
//   FINANCE_AGREEMENT_DRIVE_PARTNERS_FOLDER_ID / FINANCE_AGREEMENT_DRIVE_VENDORS_FOLDER_ID
//       Drive folder ids that receive the original signed Agreement PDFs. Optional: absent => "Drive
//       storage not configured" (never a fabricated link). Credentials are GOOGLE_APPLICATION_CREDENTIALS.
//   FINANCE_AGREEMENT_DRIVE_MODE=fake
//       DEV/TEST ONLY: selects the in-memory storage (links on the reserved .invalid host). Ignored when
//       NODE_ENV is "production".
export type FinanceAgreementDriveEnv = {
  credentialsPath: string | undefined;
  partnersFolderId: string | undefined;
  vendorsFolderId: string | undefined;
  mode: "fake" | undefined;
};

// A variable that is present but blank (KEY=) counts as absent.
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getFinanceAgreementDriveEnv(): FinanceAgreementDriveEnv {
  return {
    credentialsPath: nonBlank(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    partnersFolderId: nonBlank(process.env.FINANCE_AGREEMENT_DRIVE_PARTNERS_FOLDER_ID),
    vendorsFolderId: nonBlank(process.env.FINANCE_AGREEMENT_DRIVE_VENDORS_FOLDER_ID),
    mode: process.env.FINANCE_AGREEMENT_DRIVE_MODE?.trim() === "fake" ? "fake" : undefined,
  };
}
