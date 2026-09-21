import { Readable } from "node:stream";

import { validateContractPdf } from "../contract-artifacts/validation";

import { buildAgreementDocumentFileName, IDEMPOTENCY_KEY_PATTERN } from "./file-name";
import { isAutomatedTestRun } from "./guard";
import { AGREEMENT_DOCUMENT_FAILURE_MESSAGES, AGREEMENT_DOCUMENT_MIME_TYPE, type AgreementDocumentFailureCode, type AgreementDocumentStorage, type AgreementDocumentStoreInput, type AgreementDocumentStoreResult, type AgreementDocumentTarget } from "./types";

// Step 14B.1: the REAL Google Drive adapter for the original signed Agreement PDF.
//
//   - Folder ids come from configuration (never hard-coded); the credentials are the service-account key
//     file named by GOOGLE_APPLICATION_CREDENTIALS, exactly as the Partner / Vendor evidence uploads use.
//   - IDEMPOTENT: before creating, it lists the target folder for a file carrying the request's
//     appProperties key (the idempotency key) and returns THAT file when found, so a retry after a lost
//     response or a failed database write never creates a second file. After creating, it re-lists once
//     and, if a concurrent create raced it, keeps the earliest file (and moves its own duplicate to the
//     Drive trash - the one soft removal this adapter ever does; nothing is deleted).
//   - The exact bytes are streamed as-is (no re-encoding, no generated replacement).
//   - It REFUSES to run inside an automated test run (see guard.ts): the emulator vitest config forwards
//     .env.local, which can hold real credentials.
//   - Failures are mapped to a code + fixed message. The upstream error text (which can contain key-file
//     paths, folder ids or request ids) is never returned and never logged.
//
// googleapis is imported lazily so importing this module (through the Finance barrel) costs nothing for the
// many routes that never store a document.

export const AGREEMENT_DOCUMENT_KEY_PROPERTY = "CreatorOpsAgreementDocKey";
const AGREEMENT_REF_PROPERTY = "CreatorOpsAgreementRef";
const AGREEMENT_VERSION_PROPERTY = "CreatorOpsAgreementVersion";
const DOCUMENT_TYPE_PROPERTY = "CreatorOpsDocumentType";

// Drive folder / file ids are URL-safe; refusing anything else also keeps them safe to place in a query.
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;

export type GoogleDriveAgreementStorageConfig = {
  credentialsPath: string;
  partnersFolderId: string | undefined;
  vendorsFolderId: string | undefined;
};

function failure(code: AgreementDocumentFailureCode): AgreementDocumentStoreResult {
  return { ok: false, code, message: AGREEMENT_DOCUMENT_FAILURE_MESSAGES[code] };
}

// Maps a googleapis / gaxios error to a code WITHOUT reading anything sensitive out of it.
export function mapDriveError(error: unknown): AgreementDocumentFailureCode {
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown }; errors?: Array<{ reason?: unknown }> } | null;
  const status = Number(candidate?.response?.status ?? candidate?.status ?? candidate?.code);
  const reasons = (candidate?.errors ?? []).map((item) => String(item?.reason ?? ""));
  if (reasons.some((reason) => /storageQuotaExceeded|quotaExceeded|userRateLimitExceeded|rateLimitExceeded|dailyLimitExceeded/i.test(reason))) return "quota_exceeded";
  if (status === 401 || status === 403) return "access_denied";
  if (status === 404) return "folder_not_found";
  if (status === 429) return "quota_exceeded";
  if (status >= 500 && status <= 599) return "drive_unavailable";
  const text = typeof (error as { code?: unknown } | null)?.code === "string" ? String((error as { code: string }).code) : "";
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ESOCKETTIMEDOUT/i.test(text)) return "drive_unavailable";
  return "unknown";
}

type DriveClient = {
  files: {
    list(params: Record<string, unknown>): Promise<{ data: { files?: Array<{ id?: string | null; webViewLink?: string | null; createdTime?: string | null }> } }>;
    create(params: Record<string, unknown>): Promise<{ data: { id?: string | null; webViewLink?: string | null } }>;
    get(params: Record<string, unknown>): Promise<{ data: { id?: string | null; webViewLink?: string | null } }>;
    update(params: Record<string, unknown>): Promise<unknown>;
  };
};

async function createDriveClient(credentialsPath: string): Promise<DriveClient> {
  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({ keyFile: credentialsPath, scopes: ["https://www.googleapis.com/auth/drive"] });
  return google.drive({ version: "v3", auth }) as unknown as DriveClient;
}

function folderFor(config: GoogleDriveAgreementStorageConfig, target: AgreementDocumentTarget): string | undefined {
  const folder = target === "PARTNER" ? config.partnersFolderId : config.vendorsFolderId;
  return folder && DRIVE_ID_PATTERN.test(folder) ? folder : undefined;
}

function keyQuery(folderId: string, idempotencyKey: string): string {
  // Both interpolated values are validated against strict character sets first (folder id, hex key).
  return `'${folderId}' in parents and appProperties has { key='${AGREEMENT_DOCUMENT_KEY_PROPERTY}' and value='${idempotencyKey}' } and trashed = false`;
}

export function createGoogleDriveAgreementStorage(config: GoogleDriveAgreementStorageConfig): AgreementDocumentStorage {
  let clientPromise: Promise<DriveClient> | null = null;
  const getClient = () => (clientPromise ??= createDriveClient(config.credentialsPath));

  return {
    async store(input: AgreementDocumentStoreInput): Promise<AgreementDocumentStoreResult> {
      // The guard is evaluated on EVERY call, before anything else - including before configuration is read.
      if (isAutomatedTestRun()) return failure("live_drive_disabled_in_tests");

      if (input.mimeType !== AGREEMENT_DOCUMENT_MIME_TYPE || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) || !validateContractPdf(input.bytes).ok) return failure("invalid_input");
      if (!config.credentialsPath.trim()) return failure("not_configured");
      const folderId = folderFor(config, input.target);
      if (!folderId) return failure("not_configured");

      try {
        const drive = await getClient();
        const listInFolder = async () => {
          const listed = await drive.files.list({
            q: keyQuery(folderId, input.idempotencyKey),
            fields: "files(id, webViewLink, createdTime)",
            orderBy: "createdTime",
            pageSize: 10,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            corpora: "allDrives",
          });
          return [...(listed.data.files ?? [])].filter((file): file is { id: string; webViewLink?: string | null; createdTime?: string | null } => typeof file.id === "string" && file.id.length > 0);
        };
        const linkFor = async (file: { id: string; webViewLink?: string | null }): Promise<string | null> => {
          if (file.webViewLink) return file.webViewLink;
          const fetched = await drive.files.get({ fileId: file.id, fields: "id, webViewLink", supportsAllDrives: true });
          return fetched.data.webViewLink ?? null;
        };
        const earliest = (files: Array<{ id: string; webViewLink?: string | null; createdTime?: string | null }>) =>
          [...files].sort((a, b) => ((a.createdTime ?? "") === (b.createdTime ?? "") ? a.id.localeCompare(b.id) : (a.createdTime ?? "").localeCompare(b.createdTime ?? "")))[0];

        // 1. List-before-create: a retry resolves to the file the first attempt made.
        const already = earliest(await listInFolder());
        if (already) {
          const link = await linkFor(already);
          return link ? { ok: true, data: { fileId: already.id, webViewLink: link } } : failure("unexpected_response");
        }

        // 2. Create with the EXACT bytes and the idempotency key on the file.
        const created = await drive.files.create({
          requestBody: {
            name: buildAgreementDocumentFileName(input.fileName, input.metadata.agreementRef, input.metadata.version),
            parents: [folderId],
            appProperties: {
              [AGREEMENT_DOCUMENT_KEY_PROPERTY]: input.idempotencyKey,
              [AGREEMENT_REF_PROPERTY]: input.metadata.agreementRef,
              [AGREEMENT_VERSION_PROPERTY]: String(input.metadata.version),
              [DOCUMENT_TYPE_PROPERTY]: "AGREEMENT",
            },
          },
          media: { mimeType: AGREEMENT_DOCUMENT_MIME_TYPE, body: Readable.from(Buffer.from(input.bytes)) },
          fields: "id, webViewLink",
          supportsAllDrives: true,
        });
        const createdId = created.data.id;
        if (!createdId) return failure("unexpected_response");

        // 3. A concurrent attempt may have created its own copy: everyone agrees on the earliest file.
        let winner = { id: createdId, webViewLink: created.data.webViewLink ?? null } as { id: string; webViewLink?: string | null };
        try {
          const after = await listInFolder();
          const first = after.length > 1 ? earliest(after) : undefined;
          if (first && first.id !== createdId) {
            winner = first;
            await drive.files.update({ fileId: createdId, requestBody: { trashed: true }, supportsAllDrives: true }).catch(() => undefined);
          }
        } catch {
          // The reconcile pass is best-effort; the file just created is valid.
        }
        const link = await linkFor(winner);
        return link ? { ok: true, data: { fileId: winner.id, webViewLink: link } } : failure("unexpected_response");
      } catch (error) {
        return failure(mapDriveError(error));
      }
    },
  };
}
