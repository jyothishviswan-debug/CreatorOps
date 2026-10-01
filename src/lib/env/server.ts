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

// Remediation-plan Wave A / finding #69's external-service safety gate: a SECOND, shared switch that
// must ALSO be explicitly on before EITHER document-storage resolver below will even consider real
// Google Drive. Credentials + a folder id being present in the environment (e.g. a developer's own
// .env.local) is deliberately never enough on its own - that was the exact gap this gate closes (real
// Drive was silently selected on a real checkout whose .env.local held real credentials/folder ids
// with no opt-in flag at all). Read fresh on every call, same discipline as the rest of this file.
export function isRealExternalServicesAllowed(): boolean {
  return process.env.ALLOW_REAL_EXTERNAL_SERVICES?.trim() === "true";
}

// Step 14B.1 (revised, remediation-plan Wave A): durable Agreement-document storage (Google Drive)
// configuration. Read straight from the environment on every call (uncached, and independent of the
// Firebase project id, so a process that has no Firebase configuration can still answer "Drive storage
// not configured" truthfully).
//
//   FINANCE_AGREEMENT_DRIVE_PARTNERS_FOLDER_ID / FINANCE_AGREEMENT_DRIVE_VENDORS_FOLDER_ID
//       Drive folder ids that receive the original signed Agreement PDFs. Optional: absent => "Drive
//       storage not configured" (never a fabricated link). Credentials are GOOGLE_APPLICATION_CREDENTIALS.
//   FINANCE_AGREEMENT_DRIVE_MODE=real
//       EXPLICIT opt-in only, required before real Drive is even considered (see
//       resolveAgreementDocumentStorageKind). Credentials/folder ids being present is never, by itself,
//       enough - matches Invoices' own FINANCE_INVOICE_DRIVE_PROVIDER=google_drive discipline. Any other
//       value (unset, "fake", a typo) keeps the in-memory fake as the default outside production, and
//       NOT_CONFIGURED in production (never a silent fallback to the fake there).
//   ALLOW_REAL_EXTERNAL_SERVICES=true
//       The shared master switch above - also required, on top of mode=real, before real Drive is used.
export type FinanceAgreementDriveEnv = {
  credentialsPath: string | undefined;
  partnersFolderId: string | undefined;
  vendorsFolderId: string | undefined;
  mode: "fake" | "real" | undefined;
  allowRealExternalServices: boolean;
};

// A variable that is present but blank (KEY=) counts as absent.
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function driveMode(raw: string | undefined): "fake" | "real" | undefined {
  const trimmed = raw?.trim();
  return trimmed === "fake" ? "fake" : trimmed === "real" ? "real" : undefined;
}

export function getFinanceAgreementDriveEnv(): FinanceAgreementDriveEnv {
  return {
    credentialsPath: nonBlank(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    partnersFolderId: nonBlank(process.env.FINANCE_AGREEMENT_DRIVE_PARTNERS_FOLDER_ID),
    vendorsFolderId: nonBlank(process.env.FINANCE_AGREEMENT_DRIVE_VENDORS_FOLDER_ID),
    mode: driveMode(process.env.FINANCE_AGREEMENT_DRIVE_MODE),
    allowRealExternalServices: isRealExternalServicesAllowed(),
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
//       EXPLICIT opt-in only, required before Drive is even considered - folder id and credentials being
//       present is never, by itself, enough to select Drive. Any other value (unset, "fake", a typo)
//       keeps the in-memory fake as the default outside production, and NOT_CONFIGURED in production.
//       Never overridden by test-time env values: an automated test run always resolves to NOT_CONFIGURED
//       unless it explicitly installs a storage override.
//   ALLOW_REAL_EXTERNAL_SERVICES=true
//       Remediation-plan Wave A's shared master switch (see isRealExternalServicesAllowed above) - ALSO
//       required, on top of provider=google_drive, before real Drive is used.
export type FinanceInvoiceDriveEnv = {
  credentialsPath: string | undefined;
  folderId: string | undefined;
  provider: "google_drive" | undefined;
  allowRealExternalServices: boolean;
};

export function getFinanceInvoiceDriveEnv(): FinanceInvoiceDriveEnv {
  return {
    credentialsPath: nonBlank(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    folderId: nonBlank(process.env.FINANCE_INVOICE_DRIVE_FOLDER_ID),
    provider: process.env.FINANCE_INVOICE_DRIVE_PROVIDER?.trim() === "google_drive" ? "google_drive" : undefined,
    allowRealExternalServices: isRealExternalServicesAllowed(),
  };
}

// Findings #36/#37 (user-decided): durable Campaign Resource "Upload" storage - same fail-closed
// discipline as Finance Invoices' own single-folder Drive config above (a single flat resources folder,
// no per-counterparty split - Campaign Resources are ordinary shared resources, not restricted
// evidence). Credentials are the SAME GOOGLE_APPLICATION_CREDENTIALS every other Drive adapter uses.
//
//   CAMPAIGN_RESOURCE_DRIVE_FOLDER_ID
//       The single Drive folder id that receives uploaded Campaign Resource files. Optional: absent =>
//       "storage not configured" (never a fabricated link).
//   CAMPAIGN_RESOURCE_DRIVE_MODE=real
//       EXPLICIT opt-in only, required before real Drive is even considered - folder id and credentials
//       being present is never, by itself, enough. Any other value keeps the in-memory fake as the
//       default outside production, and NOT_CONFIGURED in production. Never overridden by test-time env
//       values - an automated test run always resolves to NOT_CONFIGURED unless it explicitly installs a
//       storage override.
//   ALLOW_REAL_EXTERNAL_SERVICES=true
//       The shared master switch above - also required, on top of mode=real, before real Drive is used.
export type CampaignResourceDriveEnv = {
  credentialsPath: string | undefined;
  folderId: string | undefined;
  mode: "fake" | "real" | undefined;
  allowRealExternalServices: boolean;
};

export function getCampaignResourceDriveEnv(): CampaignResourceDriveEnv {
  return {
    credentialsPath: nonBlank(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    folderId: nonBlank(process.env.CAMPAIGN_RESOURCE_DRIVE_FOLDER_ID),
    mode: driveMode(process.env.CAMPAIGN_RESOURCE_DRIVE_MODE),
    allowRealExternalServices: isRealExternalServicesAllowed(),
  };
}

// Production hardening (base spec section 6 - Agreement/Finance privacy hardening, carried debt item
// 7): the retention window for financeAgreementRestrictedExtractions (raw contract snippets/locators
// and raw identity VALUES extracted from an uploaded contract - never the same thing as the
// Agreement's own finalized, canonical field values, which live on the immutable
// financeAgreements/{ref}/versions record and are NEVER purged). Deliberately absent by default
// (`null`): this stage does not invent a legal/business retention period - it defines the
// CONFIGURABLE BOUNDARY per the base spec's own explicit instruction ("If retention is
// legally/business-required but not specified, define a configurable policy boundary rather than
// inventing a legal retention period"). Until a real operator sets this, restricted extraction
// records are retained indefinitely (today's actual behavior - unchanged unless explicitly
// configured). See src/server/finance-agreements/restricted-extraction-retention.ts for the
// eligibility rule and purge function this boundary feeds.
export function getFinanceAgreementRestrictedExtractionRetentionDays(): number | null {
  const raw = nonBlank(process.env.FINANCE_AGREEMENT_RESTRICTED_EXTRACTION_RETENTION_DAYS);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
