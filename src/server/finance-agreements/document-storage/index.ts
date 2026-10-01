import { getFinanceAgreementDriveEnv, type FinanceAgreementDriveEnv } from "@/lib/env/server";

import { createGoogleDriveAgreementStorage } from "./google-drive";
import { isAutomatedTestRun } from "./guard";
import { createInMemoryAgreementDocumentStorage, type FakeAgreementDocumentStorage } from "./in-memory";
import type { AgreementDocumentStorage, AgreementDocumentStorageNotConfiguredReason, AgreementDocumentStorageResolution } from "./types";

export * from "./types";
export { agreementDocumentIdempotencyKey, buildAgreementDocumentFileName } from "./file-name";
export { isAutomatedTestRun } from "./guard";
export { createInMemoryAgreementDocumentStorage, FAKE_DRIVE_LINK_HOST, type FakeAgreementDocumentStorage, type FakeStoredFile, type FakeStoreCall } from "./in-memory";
export { createGoogleDriveAgreementStorage, mapDriveError, type GoogleDriveAgreementStorageConfig } from "./google-drive";

// Step 14B.1 (revised, remediation-plan Wave A / finding #69's external-service safety gate): which
// Agreement-document storage this process uses. The choice is made from EXPLICIT configuration, never
// inferred from credential presence alone:
//   1. a test override (setAgreementDocumentStorageForTests) - tests only;
//   2. an automated test run ALWAYS resolves to NOT_CONFIGURED (never fake, never Drive) unless an
//      override is installed - same discipline as Invoices' own resolver, and the reason this file's
//      guard.ts exists at all;
//   3. real Google Drive ONLY when FINANCE_AGREEMENT_DRIVE_MODE is explicitly "real" AND the shared
//      ALLOW_REAL_EXTERNAL_SERVICES master switch is also explicitly on AND credentials + at least one
//      folder id are configured - configuration merely being PRESENT (e.g. a developer's own .env.local
//      holding real credentials/folder ids with no opt-in flag at all - the exact live gap this revision
//      closes) is never enough on its own, matching Invoices' FINANCE_INVOICE_DRIVE_PROVIDER discipline;
//   4. the in-memory FAKE otherwise, as long as this is not a production runtime (production without an
//      explicit real opt-in is a truthful NOT_CONFIGURED, never a silent fallback to the fake);
//   5. otherwise NOT_CONFIGURED - a truthful state, never a fabricated link.

type ResolveInputs = { env: FinanceAgreementDriveEnv; nodeEnv: string | undefined; testRun: boolean };

// Pure (unit-tested).
export function resolveAgreementDocumentStorageKind(inputs: ResolveInputs): "FAKE" | "GOOGLE_DRIVE" | { notConfigured: AgreementDocumentStorageNotConfiguredReason } {
  if (inputs.testRun) return { notConfigured: "live_drive_disabled_in_tests" };
  if (inputs.env.mode === "real") {
    if (!inputs.env.allowRealExternalServices) return { notConfigured: "real_external_services_not_allowed" };
    if (!inputs.env.credentialsPath?.trim()) return { notConfigured: "missing_credentials" };
    if (!inputs.env.partnersFolderId && !inputs.env.vendorsFolderId) return { notConfigured: "missing_folder" };
    return "GOOGLE_DRIVE";
  }
  if (inputs.nodeEnv === "production") return { notConfigured: "drive_mode_not_enabled" };
  return "FAKE";
}

type Override = AgreementDocumentStorage | "NOT_CONFIGURED" | null;

let storageOverride: Override = null;
let cachedGoogleStorage: AgreementDocumentStorage | null = null;
let cachedFake: FakeAgreementDocumentStorage | null = null;

export function getAgreementDocumentStorage(): AgreementDocumentStorageResolution {
  if (storageOverride === "NOT_CONFIGURED") return { state: "NOT_CONFIGURED", reason: "test_override" };
  if (storageOverride) return { state: "CONFIGURED", storage: storageOverride, mode: "TEST_OVERRIDE" };

  const env = getFinanceAgreementDriveEnv();
  const kind = resolveAgreementDocumentStorageKind({ env, nodeEnv: process.env.NODE_ENV, testRun: isAutomatedTestRun() });
  if (kind === "FAKE") {
    cachedFake ??= createInMemoryAgreementDocumentStorage();
    return { state: "CONFIGURED", storage: cachedFake, mode: "FAKE" };
  }
  if (kind === "GOOGLE_DRIVE") {
    cachedGoogleStorage ??= createGoogleDriveAgreementStorage({
      credentialsPath: env.credentialsPath!,
      partnersFolderId: env.partnersFolderId,
      vendorsFolderId: env.vendorsFolderId,
    });
    return { state: "CONFIGURED", storage: cachedGoogleStorage, mode: "GOOGLE_DRIVE" };
  }
  return { state: "NOT_CONFIGURED", reason: kind.notConfigured };
}

// Test seam (same pattern as setContractArtifactStoreForTests): an adapter, "NOT_CONFIGURED" (forces the
// truthful not-configured state) or null (back to the configured default). Throws outside a test run.
export function setAgreementDocumentStorageForTests(storage: Override): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    throw new Error("setAgreementDocumentStorageForTests may only be called from a test run.");
  }
  storageOverride = storage;
}
