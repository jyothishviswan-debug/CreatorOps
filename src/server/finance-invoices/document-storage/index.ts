import { getFinanceInvoiceDriveEnv, type FinanceInvoiceDriveEnv } from "@/lib/env/server";

import { createGoogleDriveInvoiceStorage } from "./google-drive";
import { isAutomatedTestRun } from "./guard";
import { createInMemoryInvoiceDocumentStorage, type FakeInvoiceDocumentStorage } from "./in-memory";
import type { InvoiceDocumentStorage, InvoiceDocumentStorageNotConfiguredReason, InvoiceDocumentStorageResolution } from "./types";

export * from "./types";
export { isAutomatedTestRun } from "./guard";
export { buildInvoiceDocumentFileName, IDEMPOTENCY_KEY_PATTERN } from "./file-name";
export { createInMemoryInvoiceDocumentStorage, FAKE_INVOICE_DOCUMENT_ID_PREFIX, type FakeInvoiceDocumentStorage, type FakeInvoiceStoreCall, type FakeStoredInvoiceDocument } from "./in-memory";
export { createGoogleDriveInvoiceStorage, driveInvoiceDocumentId, mapDriveError, DRIVE_INVOICE_DOCUMENT_ID_PREFIX, INVOICE_DOCUMENT_KEY_PROPERTY, type GoogleDriveInvoiceStorageConfig } from "./google-drive";
export { INVOICE_DOCUMENT_MIME_TYPE as INVOICE_PDF_MIME_TYPE, MAX_INVOICE_DOCUMENT_BYTES, sha256Hex, validateInvoicePdf, type InvoicePdfRejection, type InvoicePdfValidation } from "./validation";

// Step 16E: which Invoice-document storage this process uses. NEVER hard-coded, and - per the
// spec's own explicit instruction - NEVER a real Google Drive call in this phase:
//   1. a test override (setInvoiceDocumentStorageForTests) - tests only;
//   2. an automated test run WITHOUT an override always resolves to NOT_CONFIGURED (never the fake,
//      never Drive) - a bare `store()` call from an un-overridden automated test would otherwise
//      silently pass against the fake, defeating a test that means to prove storage is wired through
//      a fake it controls, exactly like Agreements' real-Drive guard prevents an accidental real call;
//   3. real Google Drive ONLY when FINANCE_INVOICE_DRIVE_PROVIDER is explicitly "google_drive" AND
//      both credentials and a folder id are configured - configuration merely being PRESENT is never
//      enough (section 7: "do not silently switch to Drive when env values happen to exist"), and a
//      Drive configuration problem never silently falls back to the fake (section 20);
//   4. the in-memory FAKE otherwise, as long as this is not a production runtime;
//   5. otherwise NOT_CONFIGURED - a truthful state, never a fabricated reference.

type ResolveInputs = { env: FinanceInvoiceDriveEnv; nodeEnv: string | undefined; testRun: boolean };

// Pure (unit-tested).
export function resolveInvoiceDocumentStorageKind(inputs: ResolveInputs): "FAKE" | "GOOGLE_DRIVE" | { notConfigured: InvoiceDocumentStorageNotConfiguredReason } {
  if (inputs.testRun) return { notConfigured: "live_backend_disabled_in_tests" };
  if (inputs.env.provider === "google_drive") {
    if (!inputs.env.credentialsPath?.trim()) return { notConfigured: "missing_credentials" };
    if (!inputs.env.folderId) return { notConfigured: "missing_folder" };
    return "GOOGLE_DRIVE";
  }
  if (inputs.nodeEnv === "production") return { notConfigured: "not_implemented" };
  return "FAKE";
}

type Override = InvoiceDocumentStorage | "NOT_CONFIGURED" | null;

let storageOverride: Override = null;
let cachedFake: FakeInvoiceDocumentStorage | null = null;
let cachedGoogleStorage: InvoiceDocumentStorage | null = null;

export function getInvoiceDocumentStorage(): InvoiceDocumentStorageResolution {
  if (storageOverride === "NOT_CONFIGURED") return { state: "NOT_CONFIGURED", reason: "test_override" };
  if (storageOverride) return { state: "CONFIGURED", storage: storageOverride, mode: "TEST_OVERRIDE" };

  const env = getFinanceInvoiceDriveEnv();
  const kind = resolveInvoiceDocumentStorageKind({ env, nodeEnv: process.env.NODE_ENV, testRun: isAutomatedTestRun() });
  if (kind === "FAKE") {
    cachedFake ??= createInMemoryInvoiceDocumentStorage();
    return { state: "CONFIGURED", storage: cachedFake, mode: "FAKE" };
  }
  if (kind === "GOOGLE_DRIVE") {
    cachedGoogleStorage ??= createGoogleDriveInvoiceStorage({ credentialsPath: env.credentialsPath!, folderId: env.folderId });
    return { state: "CONFIGURED", storage: cachedGoogleStorage, mode: "GOOGLE_DRIVE" };
  }
  return { state: "NOT_CONFIGURED", reason: kind.notConfigured };
}

// Test seam (same pattern as Agreements' setAgreementDocumentStorageForTests): an adapter,
// "NOT_CONFIGURED" (forces the truthful not-configured state) or null (back to the configured
// default). Throws outside a test run.
export function setInvoiceDocumentStorageForTests(storage: Override): void {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    throw new Error("setInvoiceDocumentStorageForTests may only be called from a test run.");
  }
  storageOverride = storage;
}
