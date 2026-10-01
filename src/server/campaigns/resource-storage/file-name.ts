// Mirrors finance-agreements/document-storage/file-name.ts's own sanitization idiom.
export const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{64}$/;

const UNSAFE_FILENAME_CHARS = /[/\\?%*:|"<>]/g;

export function sanitizeCampaignResourceFileName(rawName: string): string {
  const trimmed = rawName.trim() || "resource";
  return trimmed.replace(UNSAFE_FILENAME_CHARS, "_").slice(0, 200);
}

export function buildCampaignResourceFileName(rawName: string, campaignRef: string): string {
  return `${campaignRef}__${sanitizeCampaignResourceFileName(rawName)}`;
}
