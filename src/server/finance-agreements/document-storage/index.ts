import { getFinanceAgreementDriveEnv, type FinanceAgreementDriveEnv } from "@/lib/env/server";

import { createGoogleDriveAgreementStorage } from "./google-drive";
import { isAutomatedTestRun } from "./guard";
import { createInMemoryAgreementDocumentStorage, type FakeAgreementDocumentStorage } from "./in-memory";
import type { AgreementDocumentStorage, AgreementDocumentStorageResolution } from "./types";

export * from "./types";
export { agreementDocumentIdempotencyKey, buildAgreementDocumentFileName } from "./file-name";
export { isAutomatedTestRun } from "./guard";
export { createInMemoryAgreementDocumentStorage, FAKE_DRIVE_LINK_HOST, type FakeAgreementDocumentStorage, type FakeStoredFile, type FakeStoreCall } from "./in-memory";
export { createGoogleDriveAgreementStorage, mapDriveError, type GoogleDriveAgreementStorageConfig } from "./google-drive";

// Step 14B.1: which Agreement-document storage this process uses. The choice is made from configuration,
// never hard-coded:
//   1. a test override (setAgreementDocumentStorageForTests) - tests only;
//   2. FINANCE_AGREEMENT_DRIVE_MODE=fake - the in-memory fake, ONLY when NODE_ENV is not "production";
//   3. real Google Drive when credentials and at least one folder id are configured (and never inside an
//      automated test run: there the answer is NOT_CONFIGURED, and the real adapter would refuse anyway);
//   4. otherwise NOT_CONFIGURED - a truthful state, never a fabricated link.

type ResolveInputs = { env: FinanceAgreementDriveEnv; nodeEnv: string | undefined; testRun: boolean };

// Pure (unit-tested).
export function resolveAgreementDocumentStorageKind(inputs: ResolveInputs): "FAKE" | "GOOGLE_DRIVE" | { notConfigured: "missing_credentials" | "missing_folder" | "live_drive_disabled_in_tests" } {
  if (inputs.env.mode === "fake" && inputs.nodeEnv !== "production") return "FAKE";
  if (!inputs.env.credentialsPath?.trim()) return { notConfigured: "missing_credentials" };
  if (!inputs.env.partnersFolderId && !inputs.env.vendorsFolderId) return { notConfigured: "missing_folder" };
  if (inputs.testRun) return { notConfigured: "live_drive_disabled_in_tests" };
  return "GOOGLE_DRIVE";
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
