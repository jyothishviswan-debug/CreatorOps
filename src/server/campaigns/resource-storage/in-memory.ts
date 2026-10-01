import { createHash } from "node:crypto";

import { buildCampaignResourceFileName, IDEMPOTENCY_KEY_PATTERN } from "./file-name";
import {
  CAMPAIGN_RESOURCE_UPLOAD_FAILURE_MESSAGES,
  isCampaignResourceMimeType,
  type CampaignResourceStorage,
  type CampaignResourceUploadFailureCode,
  type CampaignResourceUploadInput,
  type CampaignResourceUploadMetadata,
  type CampaignResourceUploadResult,
} from "./types";

// Findings #36/#37: the FAKE Campaign Resource upload storage - used by every automated test and,
// through the explicit dev/test-only CAMPAIGN_RESOURCE_DRIVE_MODE=fake switch, by browser E2E. Mirrors
// finance-agreements/document-storage's own in-memory fake: records the EXACT bytes received, is
// idempotent by key, can be told to fail, and returns a link on the reserved ".invalid" host (RFC 2606)
// so it can never be mistaken for a real Drive file.

export const FAKE_CAMPAIGN_RESOURCE_LINK_HOST = "https://drive.invalid/fake-campaign-resource/";

export type FakeStoredCampaignResourceFile = {
  fileId: string;
  webViewLink: string;
  idempotencyKey: string;
  driveFileName: string;
  originalFileName: string;
  mimeType: string;
  metadata: CampaignResourceUploadMetadata;
  bytes: Uint8Array;
  receivedSha256: string;
};

export type FakeCampaignResourceStoreCall = { idempotencyKey: string; fileName: string; mimeType: string; byteLength: number; metadata: CampaignResourceUploadMetadata; outcome: "created" | "existing" | "failed" };

export interface FakeCampaignResourceStorage extends CampaignResourceStorage {
  readonly files: readonly FakeStoredCampaignResourceFile[];
  readonly calls: readonly FakeCampaignResourceStoreCall[];
  failNext(count: number, code?: CampaignResourceUploadFailureCode): void;
  clearFailures(): void;
  reset(): void;
}

export function createInMemoryCampaignResourceStorage(): FakeCampaignResourceStorage {
  const filesByKey = new Map<string, FakeStoredCampaignResourceFile>();
  const calls: FakeCampaignResourceStoreCall[] = [];
  let pendingFailures: Array<CampaignResourceUploadFailureCode> = [];

  const record = (input: CampaignResourceUploadInput, outcome: FakeCampaignResourceStoreCall["outcome"]) =>
    calls.push({ idempotencyKey: input.idempotencyKey, fileName: input.fileName, mimeType: input.mimeType, byteLength: input.bytes.byteLength, metadata: { ...input.metadata }, outcome });

  const fail = (input: CampaignResourceUploadInput, code: CampaignResourceUploadFailureCode, message: string): CampaignResourceUploadResult => {
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
      if (injected) return fail(input, injected, CAMPAIGN_RESOURCE_UPLOAD_FAILURE_MESSAGES[injected]);

      if (!isCampaignResourceMimeType(input.mimeType)) return fail(input, "invalid_input", "Unsupported file type.");
      if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) return fail(input, "invalid_input", "The storage request is malformed.");
      if (input.bytes.byteLength === 0) return fail(input, "invalid_input", "The file is empty.");

      const existing = filesByKey.get(input.idempotencyKey);
      if (existing) {
        record(input, "existing");
        return { ok: true, data: { fileId: existing.fileId, webViewLink: existing.webViewLink } };
      }

      const fileId = `fake_${input.idempotencyKey.slice(0, 24)}`;
      const stored: FakeStoredCampaignResourceFile = {
        fileId,
        webViewLink: `${FAKE_CAMPAIGN_RESOURCE_LINK_HOST}${fileId}`,
        idempotencyKey: input.idempotencyKey,
        driveFileName: buildCampaignResourceFileName(input.fileName, input.metadata.campaignRef),
        originalFileName: input.fileName,
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
