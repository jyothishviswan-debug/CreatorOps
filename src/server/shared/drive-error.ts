import { randomUUID } from "node:crypto";

// Production hardening (base spec section 24 - "Admin diagnostic hardening"): the shared, safe
// Google Drive error classifier/formatter for the three near-identical one-time-manual-setup Drive
// adapters (vendors/drive-client.ts, discovery/drive-client.ts, partners/drive-client.ts). Each of
// those previously carried its own copy-pasted `friendlyDriveError()` whose final fallback branch
// (`Drive request failed: ${message}`) passed a raw googleapis/gaxios exception message straight
// through to the admin-facing response - the carried "Drive diagnostic passthrough" debt. That raw
// text can include request/response internals, quota-project identifiers, or other SDK-internal
// detail that never belongs in a response body.
//
// This module mirrors the discipline finance-invoices/document-storage/google-drive.ts and
// finance-agreements/document-storage/google-drive.ts already established independently
// (`mapDriveError`): classify from the STRUCTURED error shape (HTTP status / reason codes), never
// from substring-matching the free-text message, then return one of a small fixed set of safe
// messages. Never a raw stack, raw SDK internals, or provider secret. A correlation id is included
// in both the safe response text and the sanitized server log line (classification + error name
// only, never `.message`/`.stack` - the same `console.error("[scope] ...", safeClassificationOnly)`
// shape finance-agreements/extraction-service.ts's own read-failure logging already uses) so an
// engineer can correlate a support report with the corresponding log line without either one
// carrying anything sensitive.
export type DriveErrorCode = "not_configured" | "access_denied" | "not_found" | "quota_exceeded" | "unavailable" | "unknown";

const SAFE_MESSAGE: Record<DriveErrorCode, string> = {
  not_configured: "Google Drive is not configured for this environment. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account key file path in .env.local (see .env.example), then retry.",
  access_denied: "Drive denied access. Confirm the target folder is shared with the service account as Editor/Content Manager, and that the Drive API is enabled for the project.",
  not_found: "The Drive folder could not be found. It may have been moved, deleted, or was never shared with the service account.",
  quota_exceeded: "Drive rejected the request due to a quota or rate limit. Wait and try again, or review the project's Drive API quota.",
  unavailable: "Drive is temporarily unavailable. Try again shortly.",
  unknown: "Drive request failed for an unrecognized reason. Check the server log for the correlation id below.",
};

function classifyDriveError(error: unknown): DriveErrorCode {
  if (error instanceof Error && error.message.includes("GOOGLE_APPLICATION_CREDENTIALS")) return "not_configured";
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown }; errors?: Array<{ reason?: unknown }> } | null;
  const status = Number(candidate?.response?.status ?? candidate?.status ?? candidate?.code);
  const reasons = (candidate?.errors ?? []).map((item) => String(item?.reason ?? ""));
  if (reasons.some((reason) => /storageQuotaExceeded|quotaExceeded|userRateLimitExceeded|rateLimitExceeded|dailyLimitExceeded/i.test(reason))) return "quota_exceeded";
  if (status === 401 || status === 403) return "access_denied";
  if (status === 404) return "not_found";
  if (status === 429) return "quota_exceeded";
  if (status >= 500 && status <= 599) return "unavailable";
  return "unknown";
}

// `scope` is a short, static, developer-chosen label (e.g. "vendors/drive-client") - never derived
// from user input - used only to prefix the internal log line.
export function friendlyDriveError(scope: string, error: unknown): string {
  const correlationId = randomUUID();
  const code = classifyDriveError(error);
  console.error(`[${scope}] Drive request failed`, { correlationId, code, name: error instanceof Error ? error.name : typeof error });
  return `${SAFE_MESSAGE[code]} (Google Drive, ref ${correlationId})`;
}
