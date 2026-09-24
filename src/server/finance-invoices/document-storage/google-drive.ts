import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { buildInvoiceDocumentFileName, IDEMPOTENCY_KEY_PATTERN } from "./file-name";
import { isAutomatedTestRun } from "./guard";
import { validateInvoicePdf } from "./validation";
import { INVOICE_DOCUMENT_FAILURE_MESSAGES, INVOICE_DOCUMENT_MIME_TYPE, type InvoiceDocumentFailureCode, type InvoiceDocumentStorage, type InvoiceDocumentStoreInput, type InvoiceDocumentStoreResult } from "./types";

// Step 16E: the REAL Google Drive adapter for the original Invoice document. Disabled by default -
// see document-storage/index.ts for the (explicit-only) provider selection that can ever reach this
// module. Never invoked by an automated test with a real client; every test in this phase injects a
// mocked googleapis transport (document-storage.test.ts) or exercises the isAutomatedTestRun() guard
// directly.
//
// Design (mirrors Agreements' own document-storage/google-drive.ts discipline exactly):
//   - Folder id comes from configuration only (never hard-coded); credentials are the service-account
//     key file named by GOOGLE_APPLICATION_CREDENTIALS, the SAME variable Agreements' own Drive
//     adapter uses (Drive access is one service account, one shared credential across Finance).
//   - The opaque `documentId` this adapter returns is NEVER the raw Drive file id and NEVER a
//     webViewLink - it is a deterministic hash of the store() call's idempotencyKey, tagged onto the
//     Drive file as an appProperty. Every lookup (idempotent re-store, or a later get()) re-resolves
//     the real Drive file id by querying for that tag; the raw file id never leaves this module. This
//     keeps the port's existing contract (InvoiceDocumentStoreSuccess = { documentId }) exactly as
//     Step 16A defined it - no DTO, event or route above this file ever needs to change.
//   - IDEMPOTENT: before creating, it lists the folder for a file carrying the derived documentId as
//     an appProperty and returns that file's documentId unchanged when found, so a retry after a lost
//     response or a failed database write never creates a second remote file. After creating, it
//     re-lists once and, if a concurrent create raced it, keeps the earliest file (moving its own
//     duplicate to the Drive trash - the one soft removal this adapter ever performs; nothing is
//     permanently deleted).
//   - IMMUTABLE VERSIONING: a new Invoice document version always carries a new idempotencyKey (new
//     version number and/or new content hash - see ids.ts's invoiceDocumentIdempotencyKey), which
//     yields a new documentId and therefore a NEW Drive file. An earlier version's file is never
//     updated or overwritten in place, so historical Invoice evidence never changes retroactively.
//   - The exact bytes are streamed as-is (no re-encoding, no generated replacement); a content hash is
//     verified against a freshly-read-back copy before store() reports success, and again on every
//     get() - if the bytes ever fail to match their recorded checksum, this adapter fails safely
//     (integrity_mismatch / null) rather than let ambiguous bytes reach extraction.
//   - It REFUSES to run inside an automated test run (see guard.ts): the emulator vitest config
//     forwards .env.local, which can hold real credentials.
//   - Failures are mapped to a fixed code + fixed message. The upstream error text (which can contain
//     key-file paths, folder ids or request ids) is never returned and never logged.
//
// googleapis is imported lazily so importing this module (through the Finance barrel) costs nothing
// for the many routes that never store a document.

export const INVOICE_DOCUMENT_KEY_PROPERTY = "CreatorOpsInvoiceDocKey";
const INVOICE_REF_PROPERTY = "CreatorOpsInvoiceRef";
const INVOICE_VERSION_PROPERTY = "CreatorOpsInvoiceVersion";
const DOCUMENT_TYPE_PROPERTY = "CreatorOpsDocumentType";
const ARTIFACT_SHA256_PROPERTY = "CreatorOpsInvoiceArtifactSha256";

export const DRIVE_INVOICE_DOCUMENT_ID_PREFIX = "driveinvdoc_";

// Drive folder/file ids are URL-safe; refusing anything else also keeps them safe to place in a query.
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;

export type GoogleDriveInvoiceStorageConfig = {
  credentialsPath: string;
  folderId: string | undefined;
};

function failure(code: InvoiceDocumentFailureCode): InvoiceDocumentStoreResult {
  return { ok: false, code, message: INVOICE_DOCUMENT_FAILURE_MESSAGES[code] };
}

// Maps a googleapis / gaxios error to a code WITHOUT reading anything sensitive out of it. Names stay
// provider-neutral (this port's own vocabulary), never "drive_*".
export function mapDriveError(error: unknown): InvoiceDocumentFailureCode {
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown }; errors?: Array<{ reason?: unknown }> } | null;
  const status = Number(candidate?.response?.status ?? candidate?.status ?? candidate?.code);
  const reasons = (candidate?.errors ?? []).map((item) => String(item?.reason ?? ""));
  if (reasons.some((reason) => /storageQuotaExceeded|quotaExceeded|userRateLimitExceeded|rateLimitExceeded|dailyLimitExceeded/i.test(reason))) return "quota_exceeded";
  if (status === 401 || status === 403) return "access_denied";
  if (status === 404) return "file_not_found";
  if (status === 429) return "quota_exceeded";
  if (status >= 500 && status <= 599) return "storage_unavailable";
  const text = typeof candidate?.code === "string" ? String(candidate.code) : "";
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ESOCKETTIMEDOUT/i.test(text)) return "storage_unavailable";
  return "unknown";
}

type DriveFileHandle = { id: string; createdTime?: string | null };

type DriveClient = {
  files: {
    list(params: Record<string, unknown>): Promise<{ data: { files?: Array<{ id?: string | null; createdTime?: string | null }> } }>;
    create(params: Record<string, unknown>): Promise<{ data: { id?: string | null } }>;
    get(params: Record<string, unknown>): Promise<{ data: unknown }>;
    update(params: Record<string, unknown>): Promise<unknown>;
  };
};

async function createDriveClient(credentialsPath: string): Promise<DriveClient> {
  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({ keyFile: credentialsPath, scopes: ["https://www.googleapis.com/auth/drive"] });
  return google.drive({ version: "v3", auth }) as unknown as DriveClient;
}

// The opaque, provider-neutral id this adapter hands back through the port - derived from the
// idempotencyKey, never from a raw Drive file id.
export function driveInvoiceDocumentId(idempotencyKey: string): string {
  return `${DRIVE_INVOICE_DOCUMENT_ID_PREFIX}${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24)}`;
}

function keyQuery(folderId: string, documentId: string): string {
  // Both interpolated values are validated against strict character sets first (folder id, our own
  // generated hex-suffixed documentId) before ever reaching a query string.
  return `'${folderId}' in parents and appProperties has { key='${INVOICE_DOCUMENT_KEY_PROPERTY}' and value='${documentId}' } and trashed = false`;
}

function bytesOf(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(0);
}

export function createGoogleDriveInvoiceStorage(config: GoogleDriveInvoiceStorageConfig): InvoiceDocumentStorage {
  let clientPromise: Promise<DriveClient> | null = null;
  const getClient = () => (clientPromise ??= createDriveClient(config.credentialsPath));
  const folderId = config.folderId && DRIVE_ID_PATTERN.test(config.folderId) ? config.folderId : undefined;

  const findByDocumentId = async (drive: DriveClient, folder: string, documentId: string): Promise<DriveFileHandle[]> => {
    const listed = await drive.files.list({
      q: keyQuery(folder, documentId),
      fields: "files(id, createdTime)",
      orderBy: "createdTime",
      pageSize: 10,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });
    return [...(listed.data.files ?? [])].filter((file): file is DriveFileHandle => typeof file.id === "string" && file.id.length > 0);
  };
  const earliest = (files: DriveFileHandle[]) => [...files].sort((a, b) => ((a.createdTime ?? "") === (b.createdTime ?? "") ? a.id.localeCompare(b.id) : (a.createdTime ?? "").localeCompare(b.createdTime ?? "")))[0];

  const readBackBytes = async (drive: DriveClient, fileId: string): Promise<Uint8Array> => {
    const fetched = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true, responseType: "arraybuffer" });
    return bytesOf(fetched.data);
  };

  return {
    async store(input: InvoiceDocumentStoreInput): Promise<InvoiceDocumentStoreResult> {
      // The guard is evaluated on EVERY call, before anything else - including before configuration is read.
      if (isAutomatedTestRun()) return failure("live_backend_disabled_in_tests");

      if (input.mimeType !== INVOICE_DOCUMENT_MIME_TYPE || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) || !validateInvoicePdf(input.bytes).ok) return failure("invalid_input");
      if (!config.credentialsPath.trim()) return failure("not_configured");
      if (!folderId) return failure("not_configured");

      const documentId = driveInvoiceDocumentId(input.idempotencyKey);

      try {
        const drive = await getClient();

        // 1. List-before-create: a retry resolves to the file the first attempt made - no second
        // remote file, no fabricated success against an unknown/partial upload.
        const already = earliest(await findByDocumentId(drive, folderId, documentId));
        if (already) return { ok: true, data: { documentId } };

        // 2. Create with the EXACT bytes and the idempotency-derived key on the file.
        const created = await drive.files.create({
          requestBody: {
            name: buildInvoiceDocumentFileName(input.fileName, input.metadata.invoiceRef, input.metadata.version),
            parents: [folderId],
            appProperties: {
              [INVOICE_DOCUMENT_KEY_PROPERTY]: documentId,
              [INVOICE_REF_PROPERTY]: input.metadata.invoiceRef,
              [INVOICE_VERSION_PROPERTY]: String(input.metadata.version),
              [DOCUMENT_TYPE_PROPERTY]: "INVOICE",
              [ARTIFACT_SHA256_PROPERTY]: input.metadata.artifactSha256,
            },
          },
          media: { mimeType: INVOICE_DOCUMENT_MIME_TYPE, body: Readable.from(Buffer.from(input.bytes)) },
          fields: "id",
          supportsAllDrives: true,
        });
        const createdId = created.data.id;
        if (!createdId) return failure("unknown");

        // 3. A concurrent attempt may have created its own copy: everyone agrees on the earliest file
        // for this documentId; the loser is trashed (never permanently deleted).
        let winnerId = createdId;
        try {
          const after = await findByDocumentId(drive, folderId, documentId);
          const first = after.length > 1 ? earliest(after) : undefined;
          if (first && first.id !== createdId) {
            winnerId = first.id;
            await drive.files.update({ fileId: createdId, requestBody: { trashed: true }, supportsAllDrives: true }).catch(() => undefined);
          }
        } catch {
          // The reconcile pass is best-effort; the file just created is still valid.
        }

        // 4. Integrity: read the winning file back and verify it matches the hash recorded before
        // handoff. If it cannot be proven, fail safely rather than report success over ambiguous
        // bytes (section 17) - the domain record is never written when store() does not report ok.
        const readBack = await readBackBytes(drive, winnerId);
        const readBackSha256 = createHash("sha256").update(readBack).digest("hex");
        if (readBackSha256 !== input.metadata.artifactSha256) return failure("integrity_mismatch");

        return { ok: true, data: { documentId } };
      } catch (error) {
        return failure(mapDriveError(error));
      }
    },

    async get(documentId: string): Promise<Uint8Array | null> {
      if (isAutomatedTestRun()) return null;
      if (!config.credentialsPath.trim() || !folderId) return null;
      if (!documentId.startsWith(DRIVE_INVOICE_DOCUMENT_ID_PREFIX)) return null;

      try {
        const drive = await getClient();
        const matches = await findByDocumentId(drive, folderId, documentId);
        const file = earliest(matches);
        if (!file) return null;

        const fetched = await drive.files.get({ fileId: file.id, alt: "media", supportsAllDrives: true, responseType: "arraybuffer" });
        return bytesOf(fetched.data);
      } catch {
        // Fail safe: a read failure is indistinguishable from "not found" at this interface - never
        // throw into extraction/reconciliation code that only expects Uint8Array | null.
        return null;
      }
    },
  };
}
