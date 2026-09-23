import { isAutomatedTestRun } from "./guard";
import { createInMemoryInvoiceDocumentStorage, type FakeInvoiceDocumentStorage } from "./in-memory";
import type { InvoiceDocumentStorage, InvoiceDocumentStorageResolution } from "./types";

export * from "./types";
export { isAutomatedTestRun } from "./guard";
export { createInMemoryInvoiceDocumentStorage, FAKE_INVOICE_DOCUMENT_ID_PREFIX, type FakeInvoiceDocumentStorage, type FakeInvoiceStoreCall, type FakeStoredInvoiceDocument } from "./in-memory";
export { INVOICE_DOCUMENT_MIME_TYPE as INVOICE_PDF_MIME_TYPE, MAX_INVOICE_DOCUMENT_BYTES, sha256Hex, validateInvoicePdf, type InvoicePdfRejection, type InvoicePdfValidation } from "./validation";

// Step 16A: which Invoice-document storage this process uses. NEVER hard-coded, and - per the
// spec's own explicit instruction - NEVER a real Google Drive call in this phase:
//   1. a test override (setInvoiceDocumentStorageForTests) - tests only;
//   2. the in-memory FAKE otherwise, as long as this is not a production runtime AND not an
//      automated test run without an override (a bare `store()` call from an un-overridden
//      automated test would otherwise silently pass against the fake, defeating a test that means
//      to prove storage is wired through a fake it controls - so automated test runs get
//      NOT_CONFIGURED unless they explicitly opt in with the override, exactly like Agreements'
//      real-Drive guard prevents an accidental real call);
//   3. otherwise NOT_CONFIGURED - a truthful state, never a fabricated reference. No live
//      production backend is implemented behind this port in this phase (Step 16A section 10: "do
//      not call real Google Drive" - and no other durable backend was requested either); a future
//      Payments-adjacent step can add one behind this exact interface without reshaping it.

type Override = InvoiceDocumentStorage | "NOT_CONFIGURED" | null;

let storageOverride: Override = null;
let cachedFake: FakeInvoiceDocumentStorage | null = null;

export function getInvoiceDocumentStorage(): InvoiceDocumentStorageResolution {
  if (storageOverride === "NOT_CONFIGURED") return { state: "NOT_CONFIGURED", reason: "test_override" };
  if (storageOverride) return { state: "CONFIGURED", storage: storageOverride, mode: "TEST_OVERRIDE" };

  if (isAutomatedTestRun()) return { state: "NOT_CONFIGURED", reason: "live_backend_disabled_in_tests" };
  if (process.env.NODE_ENV === "production") return { state: "NOT_CONFIGURED", reason: "not_implemented" };

  cachedFake ??= createInMemoryInvoiceDocumentStorage();
  return { state: "CONFIGURED", storage: cachedFake, mode: "FAKE" };
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
