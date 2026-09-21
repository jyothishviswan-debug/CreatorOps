import { AGREEMENT_DOCUMENT_FAILURE_CODES, type AgreementDocumentFailureCode } from "../terms";
import type { CounterpartyType } from "../types";

// Step 14B.1: the durable-document seam. The ORIGINAL signed Agreement PDF (the exact bytes the user
// uploaded and extraction ran on) is written to a configured Google Drive folder AFTER the Agreement
// version is confirmed. Everything Finance needs from a storage backend is this one interface, so tests
// use the in-memory fake and never reach Google.
//
// SECURITY: an adapter never receives a credential in its input, and never returns one. Failure messages
// are fixed, human-readable strings - a raw upstream error (which can carry key-file paths, folder ids or
// request ids) is mapped to a code and dropped.

export const AGREEMENT_DOCUMENT_MIME_TYPE = "application/pdf" as const;

export type AgreementDocumentTarget = CounterpartyType;

export type AgreementDocumentMetadata = {
  agreementRef: string;
  version: number;
  counterpartyType: CounterpartyType;
  counterpartyRef: string;
  // sha256 (hex) of the exact bytes being stored.
  artifactSha256: string;
};

export type AgreementDocumentStoreInput = {
  // sha256(agreementRef|version|artifactSha256), hex. The same key always resolves to the same stored file.
  idempotencyKey: string;
  // The EXACT original bytes. Never a generated replacement.
  bytes: Uint8Array;
  mimeType: typeof AGREEMENT_DOCUMENT_MIME_TYPE;
  // The ORIGINAL (already sanitized) file name of the upload; the adapter derives the stored name from it.
  fileName: string;
  target: AgreementDocumentTarget;
  metadata: AgreementDocumentMetadata;
};

export { AGREEMENT_DOCUMENT_FAILURE_CODES, type AgreementDocumentFailureCode };

// Fixed, human-readable text per failure code - the ONLY text any surface shows for a failed attempt.
export const AGREEMENT_DOCUMENT_FAILURE_MESSAGES: Record<AgreementDocumentFailureCode, string> = {
  not_configured: "Drive storage not configured",
  live_drive_disabled_in_tests: "Real Drive storage is disabled in automated test runs.",
  invalid_input: "The document could not be stored because the request was not valid.",
  access_denied: "Drive denied access. Confirm the Agreement folder is shared with the service account as an editor.",
  folder_not_found: "The Agreement folder could not be found in Drive. Check the configured folder.",
  quota_exceeded: "Drive could not store the file (storage quota). Try again later or contact an administrator.",
  drive_unavailable: "Drive is temporarily unavailable. Try again.",
  unexpected_response: "Drive returned an unexpected response. Try again.",
  artifact_unavailable: "The original document could not be read back.",
  artifact_mismatch: "The original document did not match its recorded checksum.",
  unknown: "The document could not be stored. Try again.",
};

export type AgreementDocumentStoreSuccess = { fileId: string; webViewLink: string };

export type AgreementDocumentStoreResult = { ok: true; data: AgreementDocumentStoreSuccess } | { ok: false; code: AgreementDocumentFailureCode; message: string };

export interface AgreementDocumentStorage {
  // Idempotent by `idempotencyKey`: a repeat returns the SAME fileId / link and creates no second file.
  store(input: AgreementDocumentStoreInput): Promise<AgreementDocumentStoreResult>;
}

// What getAgreementDocumentStorage() answers: an adapter, or a truthful NOT_CONFIGURED state (never a fabricated link).
export type AgreementDocumentStorageNotConfiguredReason = "missing_credentials" | "missing_folder" | "live_drive_disabled_in_tests" | "test_override";

export type AgreementDocumentStorageResolution =
  | { state: "CONFIGURED"; storage: AgreementDocumentStorage; mode: "GOOGLE_DRIVE" | "FAKE" | "TEST_OVERRIDE" }
  | { state: "NOT_CONFIGURED"; reason: AgreementDocumentStorageNotConfiguredReason };

// The plain sentence every surface uses for the not-configured state.
export const DRIVE_NOT_CONFIGURED_MESSAGE = "Drive storage not configured";
