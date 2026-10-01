import { Readable } from "node:stream";

import { isAutomatedTestRun } from "../../finance-agreements/document-storage/guard";

import { buildCampaignResourceFileName, IDEMPOTENCY_KEY_PATTERN } from "./file-name";
import {
  CAMPAIGN_RESOURCE_UPLOAD_FAILURE_MESSAGES,
  isCampaignResourceMimeType,
  type CampaignResourceStorage,
  type CampaignResourceUploadFailureCode,
  type CampaignResourceUploadInput,
  type CampaignResourceUploadResult,
} from "./types";

// Findings #36/#37: the REAL Google Drive adapter for a Campaign Resource "Upload". Mirrors
// finance-agreements/document-storage/google-drive.ts's own list-before-create idempotency, concurrent-
// create reconciliation, and error-mapping discipline - generalized for a small set of allowed MIME
// types (not hard-locked to PDF) and one flat shared folder (Campaign Resources have no counterparty
// split, unlike Agreement documents). Credentials come from GOOGLE_APPLICATION_CREDENTIALS, the same
// service-account key every other Drive adapter in this codebase uses.
//
// googleapis is imported lazily so importing this module costs nothing for the many requests that never
// store a Campaign Resource upload.

export const CAMPAIGN_RESOURCE_KEY_PROPERTY = "CreatorOpsCampaignResourceKey";
const CAMPAIGN_REF_PROPERTY = "CreatorOpsCampaignRef";
const RESOURCE_REF_PROPERTY = "CreatorOpsResourceRef";

const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;

export type GoogleDriveCampaignResourceStorageConfig = {
  credentialsPath: string;
  folderId: string | undefined;
};

function failure(code: CampaignResourceUploadFailureCode): CampaignResourceUploadResult {
  return { ok: false, code, message: CAMPAIGN_RESOURCE_UPLOAD_FAILURE_MESSAGES[code] };
}

export function mapDriveError(error: unknown): CampaignResourceUploadFailureCode {
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

function keyQuery(folderId: string, idempotencyKey: string): string {
  return `'${folderId}' in parents and appProperties has { key='${CAMPAIGN_RESOURCE_KEY_PROPERTY}' and value='${idempotencyKey}' } and trashed = false`;
}

export function createGoogleDriveCampaignResourceStorage(config: GoogleDriveCampaignResourceStorageConfig): CampaignResourceStorage {
  let clientPromise: Promise<DriveClient> | null = null;
  const getClient = () => (clientPromise ??= createDriveClient(config.credentialsPath));

  return {
    async store(input: CampaignResourceUploadInput): Promise<CampaignResourceUploadResult> {
      if (isAutomatedTestRun()) return failure("live_drive_disabled_in_tests");

      if (!isCampaignResourceMimeType(input.mimeType) || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) || input.bytes.byteLength === 0) return failure("invalid_input");
      if (!config.credentialsPath.trim()) return failure("not_configured");
      const folderId = config.folderId && DRIVE_ID_PATTERN.test(config.folderId) ? config.folderId : undefined;
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

        const already = earliest(await listInFolder());
        if (already) {
          const link = await linkFor(already);
          return link ? { ok: true, data: { fileId: already.id, webViewLink: link } } : failure("unexpected_response");
        }

        const created = await drive.files.create({
          requestBody: {
            name: buildCampaignResourceFileName(input.fileName, input.metadata.campaignRef),
            parents: [folderId],
            appProperties: {
              [CAMPAIGN_RESOURCE_KEY_PROPERTY]: input.idempotencyKey,
              [CAMPAIGN_REF_PROPERTY]: input.metadata.campaignRef,
              [RESOURCE_REF_PROPERTY]: input.metadata.resourceRef,
            },
          },
          media: { mimeType: input.mimeType, body: Readable.from(Buffer.from(input.bytes)) },
          fields: "id, webViewLink",
          supportsAllDrives: true,
        });
        const createdId = created.data.id;
        if (!createdId) return failure("unexpected_response");

        let winner = { id: createdId, webViewLink: created.data.webViewLink ?? null } as { id: string; webViewLink?: string | null };
        try {
          const after = await listInFolder();
          const first = after.length > 1 ? earliest(after) : undefined;
          if (first && first.id !== createdId) {
            winner = first;
            await drive.files.update({ fileId: createdId, requestBody: { trashed: true }, supportsAllDrives: true }).catch(() => undefined);
          }
        } catch {
          // Best-effort reconcile - the file just created is still valid.
        }
        const link = await linkFor(winner);
        return link ? { ok: true, data: { fileId: winner.id, webViewLink: link } } : failure("unexpected_response");
      } catch (error) {
        return failure(mapDriveError(error));
      }
    },
  };
}
