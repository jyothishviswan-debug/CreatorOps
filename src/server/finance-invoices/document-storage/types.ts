import type { InvoiceCounterpartyType } from "../types";

// Step 16A: the Invoice document-storage port - a provider-neutral seam mirroring Agreements' own
// document-storage/types.ts shape/discipline exactly, scoped to Invoice metadata (Agreements' own
// port is not reusable as-is: its metadata is keyed to agreementRef/version and its folder ids are
// Agreement-specific - see this module's index.ts). Everything an Invoice needs from a storage
// backend is this one interface, so tests use the in-memory fake and never reach Google.
//
// SECURITY: an adapter never receives a credential in its input, and never returns one. Failure
// messages are fixed, human-readable strings.

export const INVOICE_DOCUMENT_MIME_TYPE = "application/pdf" as const;

export type InvoiceDocumentMetadata = {
  invoiceRef: string;
  version: number;
  counterpartyType: InvoiceCounterpartyType;
  counterpartyRef: string;
  // sha256 (hex) of the exact bytes being stored.
  artifactSha256: string;
};

export type InvoiceDocumentStoreInput = {
  // sha256(invoiceRef|version|artifactSha256), hex. The same key always resolves to the same
  // stored file.
  idempotencyKey: string;
  // The EXACT original bytes. Never a generated replacement.
  bytes: Uint8Array;
  mimeType: typeof INVOICE_DOCUMENT_MIME_TYPE;
  // The ORIGINAL (already sanitized) file name of the upload; the adapter derives the stored name
  // from it.
  fileName: string;
  metadata: InvoiceDocumentMetadata;
};

// Step 16E adds four provider-neutral failure states (access_denied, file_not_found, quota_exceeded,
// integrity_mismatch) needed to map real Google Drive failures deterministically - see
// document-storage/google-drive.ts's mapDriveError. The FAKE adapter never produces these unless a
// test explicitly injects them with failNext(). Names stay provider-neutral (never "drive_*") because
// this port must not leak which backend is behind it.
export const INVOICE_DOCUMENT_FAILURE_CODES = ["not_configured", "live_backend_disabled_in_tests", "invalid_input", "storage_unavailable", "access_denied", "file_not_found", "quota_exceeded", "integrity_mismatch", "unknown"] as const;
export type InvoiceDocumentFailureCode = (typeof INVOICE_DOCUMENT_FAILURE_CODES)[number];

export const INVOICE_DOCUMENT_FAILURE_MESSAGES: Record<InvoiceDocumentFailureCode, string> = {
  not_configured: "Document storage not configured",
  live_backend_disabled_in_tests: "A real document storage backend is disabled in automated test runs.",
  invalid_input: "The document could not be stored because the request was not valid.",
  storage_unavailable: "Document storage is temporarily unavailable. Try again.",
  access_denied: "Document storage denied access. Confirm the Invoice folder is shared with the service account as an editor.",
  file_not_found: "The Invoice document folder could not be found in storage. Check the configured folder.",
  quota_exceeded: "Document storage could not store the file (storage quota). Try again later or contact an administrator.",
  integrity_mismatch: "The document could not be verified against its recorded checksum.",
  unknown: "The document could not be stored. Try again.",
};

export type InvoiceDocumentStoreSuccess = { documentId: string };

export type InvoiceDocumentStoreResult = { ok: true; data: InvoiceDocumentStoreSuccess } | { ok: false; code: InvoiceDocumentFailureCode; message: string };

export interface InvoiceDocumentStorage {
  // Idempotent by `idempotencyKey`: a repeat returns the SAME documentId and creates no second file.
  store(input: InvoiceDocumentStoreInput): Promise<InvoiceDocumentStoreResult>;
  // Reads the exact bytes back, for a future retrieval surface. Never called by anything in this
  // phase's automated tests except the fake's own round-trip proof.
  get(documentId: string): Promise<Uint8Array | null>;
}

// What getInvoiceDocumentStorage() answers: an adapter, or a truthful NOT_CONFIGURED state (never a
// fabricated reference). Step 16A shipped only the fake (dev/test) behind this port. Step 16E adds a
// real Google Drive adapter behind the SAME interface, selected ONLY by explicit configuration (see
// document-storage/index.ts's resolveInvoiceDocumentStorageKind) - it is never live in an automated
// test run, and a missing/invalid Drive configuration fails closed to NOT_CONFIGURED, never a silent
// fallback to the fake.
export type InvoiceDocumentStorageNotConfiguredReason = "live_backend_disabled_in_tests" | "test_override" | "not_implemented" | "missing_credentials" | "missing_folder";

export type InvoiceDocumentStorageResolution = { state: "CONFIGURED"; storage: InvoiceDocumentStorage; mode: "FAKE" | "TEST_OVERRIDE" | "GOOGLE_DRIVE" } | { state: "NOT_CONFIGURED"; reason: InvoiceDocumentStorageNotConfiguredReason };

export const INVOICE_DOCUMENT_STORAGE_NOT_CONFIGURED_MESSAGE = "Document storage not configured";
