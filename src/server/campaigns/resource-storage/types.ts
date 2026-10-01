// Findings #36/#37 (user-decided): the Campaign Resource "Upload" storage seam. Mirrors
// finance-agreements/document-storage's own shape/gating discipline (resolver + fake + real adapter +
// test-run guard), but as its own sibling module rather than reusing that module's concrete type - that
// one is hard-locked to application/pdf and Agreement/counterparty-specific metadata, neither of which
// fits an ordinary Campaign Resource upload (any of a small allowed set of common file types, one flat
// shared folder, no counterparty split).
//
// SECURITY: an adapter never receives a credential in its input, and never returns one. Failure messages
// are fixed, human-readable strings - a raw upstream error is mapped to a code and dropped.

export const CAMPAIGN_RESOURCE_ALLOWED_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"] as const;
export type CampaignResourceMimeType = (typeof CAMPAIGN_RESOURCE_ALLOWED_MIME_TYPES)[number];

export function isCampaignResourceMimeType(value: string): value is CampaignResourceMimeType {
  return (CAMPAIGN_RESOURCE_ALLOWED_MIME_TYPES as readonly string[]).includes(value);
}

export const CAMPAIGN_RESOURCE_UPLOAD_FAILURE_CODES = [
  "not_configured",
  "live_drive_disabled_in_tests",
  "invalid_input",
  "access_denied",
  "folder_not_found",
  "quota_exceeded",
  "drive_unavailable",
  "unexpected_response",
  "unknown",
] as const;
export type CampaignResourceUploadFailureCode = (typeof CAMPAIGN_RESOURCE_UPLOAD_FAILURE_CODES)[number];

export const CAMPAIGN_RESOURCE_UPLOAD_FAILURE_MESSAGES: Record<CampaignResourceUploadFailureCode, string> = {
  not_configured: "Upload storage not configured",
  live_drive_disabled_in_tests: "Real Drive storage is disabled in automated test runs.",
  invalid_input: "The file could not be stored because the request was not valid.",
  access_denied: "Drive denied access. Confirm the resources folder is shared with the service account as an editor.",
  folder_not_found: "The resources folder could not be found in Drive. Check the configured folder.",
  quota_exceeded: "Drive could not store the file (storage quota). Try again later or contact an administrator.",
  drive_unavailable: "Drive is temporarily unavailable. Try again.",
  unexpected_response: "Drive returned an unexpected response. Try again.",
  unknown: "The file could not be stored. Try again.",
};

export type CampaignResourceUploadMetadata = {
  campaignRef: string;
  resourceRef: string;
};

export type CampaignResourceUploadInput = {
  // sha256(campaignRef|resourceRef|contentSha256), hex - the same key always resolves to the same file.
  idempotencyKey: string;
  bytes: Uint8Array;
  mimeType: CampaignResourceMimeType;
  fileName: string;
  metadata: CampaignResourceUploadMetadata;
};

export type CampaignResourceUploadSuccess = { fileId: string; webViewLink: string };

export type CampaignResourceUploadResult = { ok: true; data: CampaignResourceUploadSuccess } | { ok: false; code: CampaignResourceUploadFailureCode; message: string };

export interface CampaignResourceStorage {
  // Idempotent by `idempotencyKey`: a repeat returns the SAME fileId / link and creates no second file.
  store(input: CampaignResourceUploadInput): Promise<CampaignResourceUploadResult>;
}

export type CampaignResourceStorageNotConfiguredReason = "missing_credentials" | "missing_folder" | "live_drive_disabled_in_tests" | "test_override" | "real_external_services_not_allowed" | "drive_mode_not_enabled";

export type CampaignResourceStorageResolution =
  | { state: "CONFIGURED"; storage: CampaignResourceStorage; mode: "GOOGLE_DRIVE" | "FAKE" | "TEST_OVERRIDE" }
  | { state: "NOT_CONFIGURED"; reason: CampaignResourceStorageNotConfiguredReason };

export const CAMPAIGN_RESOURCE_UPLOAD_NOT_CONFIGURED_MESSAGE = "Upload storage not configured";
