import { createHash } from "node:crypto";

import { INVOICE_DOCUMENT_MIME_TYPE } from "./types";
import { validateInvoicePdf } from "./validation";
import type { InvoiceDocumentFailureCode, InvoiceDocumentMetadata, InvoiceDocumentStorage, InvoiceDocumentStoreInput, InvoiceDocumentStoreResult } from "./types";

// Step 16A: the FAKE Invoice-document storage. Used by every automated test and by dev-only preview
// work. Records the EXACT bytes and arguments it receives (so a test can prove the uploaded
// original - not a generated substitute - reached storage), is idempotent by key like a real
// adapter would be, and can be told to fail. Mirrors Agreements' own in-memory fake.

export const FAKE_INVOICE_DOCUMENT_ID_PREFIX = "fakeinvdoc_";

export type FakeStoredInvoiceDocument = {
  documentId: string;
  idempotencyKey: string;
  fileName: string;
  mimeType: string;
  metadata: InvoiceDocumentMetadata;
  // A private COPY of the exact bytes received.
  bytes: Uint8Array;
  receivedSha256: string;
};

export type FakeInvoiceStoreCall = { idempotencyKey: string; fileName: string; mimeType: string; byteLength: number; metadata: InvoiceDocumentMetadata; outcome: "created" | "existing" | "failed" };

export interface FakeInvoiceDocumentStorage extends InvoiceDocumentStorage {
  readonly files: readonly FakeStoredInvoiceDocument[];
  readonly calls: readonly FakeInvoiceStoreCall[];
  failNext(count: number, code?: InvoiceDocumentFailureCode): void;
  clearFailures(): void;
  reset(): void;
}

export function createInMemoryInvoiceDocumentStorage(): FakeInvoiceDocumentStorage {
  const filesByKey = new Map<string, FakeStoredInvoiceDocument>();
  const filesById = new Map<string, FakeStoredInvoiceDocument>();
  const calls: FakeInvoiceStoreCall[] = [];
  let pendingFailures: InvoiceDocumentFailureCode[] = [];

  const record = (input: InvoiceDocumentStoreInput, outcome: FakeInvoiceStoreCall["outcome"]) =>
    calls.push({ idempotencyKey: input.idempotencyKey, fileName: input.fileName, mimeType: input.mimeType, byteLength: input.bytes.byteLength, metadata: { ...input.metadata }, outcome });

  const fail = (input: InvoiceDocumentStoreInput, code: InvoiceDocumentFailureCode, message: string): InvoiceDocumentStoreResult => {
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
    failNext(count, code = "storage_unavailable") {
      pendingFailures = [...pendingFailures, ...Array.from({ length: Math.max(0, count) }, () => code)];
    },
    clearFailures() {
      pendingFailures = [];
    },
    reset() {
      filesByKey.clear();
      filesById.clear();
      calls.length = 0;
      pendingFailures = [];
    },
    async store(input) {
      const injected = pendingFailures.shift();
      if (injected) return fail(input, injected, `${injected}`);

      if (input.mimeType !== INVOICE_DOCUMENT_MIME_TYPE) return fail(input, "invalid_input", "Only a PDF can be stored.");
      if (!/^[0-9a-f]{64}$/.test(input.idempotencyKey)) return fail(input, "invalid_input", "The storage request is malformed.");
      if (!validateInvoicePdf(input.bytes).ok) return fail(input, "invalid_input", "The file is not a valid PDF.");

      const existing = filesByKey.get(input.idempotencyKey);
      if (existing) {
        record(input, "existing");
        return { ok: true, data: { documentId: existing.documentId } };
      }

      const documentId = `${FAKE_INVOICE_DOCUMENT_ID_PREFIX}${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 24)}`;
      const stored: FakeStoredInvoiceDocument = {
        documentId,
        idempotencyKey: input.idempotencyKey,
        fileName: input.fileName,
        mimeType: input.mimeType,
        metadata: { ...input.metadata },
        bytes: new Uint8Array(input.bytes),
        receivedSha256: createHash("sha256").update(input.bytes).digest("hex"),
      };
      filesByKey.set(input.idempotencyKey, stored);
      filesById.set(documentId, stored);
      record(input, "created");
      return { ok: true, data: { documentId } };
    },
    async get(documentId) {
      const stored = filesById.get(documentId);
      return stored ? new Uint8Array(stored.bytes) : null;
    },
  };
}
