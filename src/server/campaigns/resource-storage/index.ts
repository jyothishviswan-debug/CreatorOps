import { getCampaignResourceDriveEnv, type CampaignResourceDriveEnv } from "@/lib/env/server";
import { isAutomatedTestRun } from "../../finance-agreements/document-storage/guard";

import { createGoogleDriveCampaignResourceStorage } from "./google-drive";
import { createInMemoryCampaignResourceStorage, type FakeCampaignResourceStorage } from "./in-memory";
import type { CampaignResourceStorage, CampaignResourceStorageNotConfiguredReason, CampaignResourceStorageResolution } from "./types";

export * from "./types";
export { sanitizeCampaignResourceFileName, buildCampaignResourceFileName } from "./file-name";
export { createInMemoryCampaignResourceStorage, FAKE_CAMPAIGN_RESOURCE_LINK_HOST, type FakeCampaignResourceStorage, type FakeStoredCampaignResourceFile, type FakeCampaignResourceStoreCall } from "./in-memory";
export { createGoogleDriveCampaignResourceStorage, mapDriveError, type GoogleDriveCampaignResourceStorageConfig } from "./google-drive";

// Findings #36/#37 (user-decided): which Campaign Resource "Upload" storage this process uses - same
// explicit-configuration-only discipline as finance-agreements/document-storage's own resolver:
//   1. a test override (setCampaignResourceStorageForTests) - tests only;
//   2. an automated test run ALWAYS resolves to NOT_CONFIGURED unless an override is installed;
//   3. real Google Drive ONLY when CAMPAIGN_RESOURCE_DRIVE_MODE is explicitly "real" AND the shared
//      ALLOW_REAL_EXTERNAL_SERVICES master switch is also explicitly on AND credentials + a folder id
//      are configured;
//   4. the in-memory FAKE otherwise, as long as this is not a production runtime;
//   5. otherwise NOT_CONFIGURED - a truthful state, never a fabricated link.

type ResolveInputs = { env: CampaignResourceDriveEnv; nodeEnv: string | undefined; testRun: boolean };

export function resolveCampaignResourceStorageKind(inputs: ResolveInputs): "FAKE" | "GOOGLE_DRIVE" | { notConfigured: CampaignResourceStorageNotConfiguredReason } {
  if (inputs.testRun) return { notConfigured: "live_drive_disabled_in_tests" };
  if (inputs.env.mode === "real") {
    if (!inputs.env.allowRealExternalServices) return { notConfigured: "real_external_services_not_allowed" };
    if (!inputs.env.credentialsPath?.trim()) return { notConfigured: "missing_credentials" };
    if (!inputs.env.folderId) return { notConfigured: "missing_folder" };
    return "GOOGLE_DRIVE";
  }
  if (inputs.nodeEnv === "production") return { notConfigured: "drive_mode_not_enabled" };
  return "FAKE";
}

type Override = CampaignResourceStorage | "NOT_CONFIGURED" | null;

let storageOverride: Override = null;
let cachedGoogleStorage: CampaignResourceStorage | null = null;
let cachedFake: FakeCampaignResourceStorage | null = null;

export function getCampaignResourceStorage(): CampaignResourceStorageResolution {
  if (storageOverride === "NOT_CONFIGURED") return { state: "NOT_CONFIGURED", reason: "test_override" };
  if (storageOverride) return { state: "CONFIGURED", storage: storageOverride, mode: "TEST_OVERRIDE" };

  const env = getCampaignResourceDriveEnv();
  const kind = resolveCampaignResourceStorageKind({ env, nodeEnv: process.env.NODE_ENV, testRun: isAutomatedTestRun() });
  if (kind === "FAKE") {
    cachedFake ??= createInMemoryCampaignResourceStorage();
    return { state: "CONFIGURED", storage: cachedFake, mode: "FAKE" };
  }
  if (kind === "GOOGLE_DRIVE") {
    cachedGoogleStorage ??= createGoogleDriveCampaignResourceStorage({ credentialsPath: env.credentialsPath!, folderId: env.folderId });
    return { state: "CONFIGURED", storage: cachedGoogleStorage, mode: "GOOGLE_DRIVE" };
  }
  return { state: "NOT_CONFIGURED", reason: kind.notConfigured };
}

// Test seam (same pattern as setAgreementDocumentStorageForTests).
export function setCampaignResourceStorageForTests(storage: Override): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    throw new Error("setCampaignResourceStorageForTests may only be called from a test run.");
  }
  storageOverride = storage;
}
