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

// Step 16E: durable Invoice-document storage (Google Drive) configuration. Read straight from the
// environment on every call, same discipline as Agreements' own env above.
//
//   FINANCE_INVOICE_DRIVE_FOLDER_ID
//       The single Drive folder id that receives original Invoice document PDFs. Optional: absent =>
//       "Document storage not configured" (never a fabricated reference). Credentials are the SAME
//       GOOGLE_APPLICATION_CREDENTIALS Agreements' own Drive adapter uses.
//   FINANCE_INVOICE_DRIVE_PROVIDER=google_drive
//       EXPLICIT opt-in only. Unlike Agreements' own resolver (which infers Drive from configuration
//       presence), Step 16E requires this exact value before Drive is even considered - folder id and
//       credentials being present is never, by itself, enough to select Drive. Any other value (unset,
//       "fake", a typo) keeps the in-memory fake as the default outside production, and NOT_CONFIGURED
//       in production. Never overridden by test-time env values: an automated test run always resolves
//       to NOT_CONFIGURED unless it explicitly installs a storage override.
export type FinanceInvoiceDriveEnv = {
  credentialsPath: string | undefined;
  folderId: string | undefined;
  provider: "google_drive" | undefined;
};

export function getFinanceInvoiceDriveEnv(): FinanceInvoiceDriveEnv {
  return {
    credentialsPath: nonBlank(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    folderId: nonBlank(process.env.FINANCE_INVOICE_DRIVE_FOLDER_ID),
    provider: process.env.FINANCE_INVOICE_DRIVE_PROVIDER?.trim() === "google_drive" ? "google_drive" : undefined,
  };
}
