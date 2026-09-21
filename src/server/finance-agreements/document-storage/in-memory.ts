import { createHash } from "node:crypto";

import { validateContractPdf } from "../contract-artifacts/validation";

import { buildAgreementDocumentFileName, IDEMPOTENCY_KEY_PATTERN } from "./file-name";
import { AGREEMENT_DOCUMENT_FAILURE_MESSAGES, AGREEMENT_DOCUMENT_MIME_TYPE, type AgreementDocumentFailureCode, type AgreementDocumentMetadata, type AgreementDocumentStorage, type AgreementDocumentStoreInput, type AgreementDocumentStoreResult, type AgreementDocumentTarget } from "./types";

// Step 14B.1: the FAKE Agreement-document storage. Used by every automated test and, through the explicit
// dev/test-only FINANCE_AGREEMENT_DRIVE_MODE=fake switch, by browser E2E. It records the EXACT bytes and
// arguments it receives (so a test can prove the uploaded original - not a generated substitute - reached
// storage), is idempotent by key like the real adapter, and can be told to fail.
//
// A fake link points at the reserved ".invalid" host (RFC 2606) so it can never be mistaken for, or
// resolve to, a real Drive file.

export const FAKE_DRIVE_LINK_HOST = "https://drive.invalid/fake/";

export type FakeStoredFile = {
  fileId: string;
  webViewLink: string;
  idempotencyKey: string;
  // The normalized stored name (what the real adapter would give the Drive file).
  driveFileName: string;
  originalFileName: string;
  target: AgreementDocumentTarget;
  mimeType: string;
  metadata: AgreementDocumentMetadata;
  // A private COPY of the exact bytes received.
  bytes: Uint8Array;
  // sha256 (hex) of the received bytes - compare against the uploaded PDF's own digest.
  receivedSha256: string;
};

export type FakeStoreCall = { idempotencyKey: string; fileName: string; target: AgreementDocumentTarget; mimeType: string; byteLength: number; metadata: AgreementDocumentMetadata; outcome: "created" | "existing" | "failed" };

export interface FakeAgreementDocumentStorage extends AgreementDocumentStorage {
  // One entry per distinct idempotency key - the physical files.
  readonly files: readonly FakeStoredFile[];
  // Every store() call in order, including failed ones.
  readonly calls: readonly FakeStoreCall[];
  // The next `count` store() calls fail with `code` (default drive_unavailable) and store nothing.
  failNext(count: number, code?: AgreementDocumentFailureCode): void;
  clearFailures(): void;
  reset(): void;
}

export function createInMemoryAgreementDocumentStorage(): FakeAgreementDocumentStorage {
  const filesByKey = new Map<string, FakeStoredFile>();
  const calls: FakeStoreCall[] = [];
  let pendingFailures: Array<AgreementDocumentFailureCode> = [];

  const record = (input: AgreementDocumentStoreInput, outcome: FakeStoreCall["outcome"]) =>
    calls.push({ idempotencyKey: input.idempotencyKey, fileName: input.fileName, target: input.target, mimeType: input.mimeType, byteLength: input.bytes.byteLength, metadata: { ...input.metadata }, outcome });

  const fail = (input: AgreementDocumentStoreInput, code: AgreementDocumentFailureCode, message: string): AgreementDocumentStoreResult => {
    record(input, "failed");
    return { ok: false, code, message };
  };

  return {
    get files() {
      return [...filesByKey.values()];
    },
    get calls() {
      return [...calls];
    },
    failNext(count, code = "drive_unavailable") {
      pendingFailures = [...pendingFailures, ...Array.from({ length: Math.max(0, count) }, () => code)];
    },
    clearFailures() {
      pendingFailures = [];
    },
    reset() {
      filesByKey.clear();
      calls.length = 0;
      pendingFailures = [];
    },
    async store(input) {
      const injected = pendingFailures.shift();
      if (injected) return fail(input, injected, AGREEMENT_DOCUMENT_FAILURE_MESSAGES[injected]);

      if (input.mimeType !== AGREEMENT_DOCUMENT_MIME_TYPE) return fail(input, "invalid_input", "Only a PDF can be stored.");
      if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) return fail(input, "invalid_input", "The storage request is malformed.");
      if (!validateContractPdf(input.bytes).ok) return fail(input, "invalid_input", "The file is not a valid PDF.");

      const existing = filesByKey.get(input.idempotencyKey);
      if (existing) {
        record(input, "existing");
        return { ok: true, data: { fileId: existing.fileId, webViewLink: existing.webViewLink } };
      }

      const fileId = `fake_${input.idempotencyKey.slice(0, 24)}`;
      const stored: FakeStoredFile = {
        fileId,
        webViewLink: `${FAKE_DRIVE_LINK_HOST}${fileId}`,
        idempotencyKey: input.idempotencyKey,
        driveFileName: buildAgreementDocumentFileName(input.fileName, input.metadata.agreementRef, input.metadata.version),
        originalFileName: input.fileName,
        target: input.target,
        mimeType: input.mimeType,
        metadata: { ...input.metadata },
        bytes: new Uint8Array(input.bytes),
        receivedSha256: createHash("sha256").update(input.bytes).digest("hex"),
      };
      filesByKey.set(input.idempotencyKey, stored);
      record(input, "created");
      return { ok: true, data: { fileId, webViewLink: stored.webViewLink } };
    },
  };
}
