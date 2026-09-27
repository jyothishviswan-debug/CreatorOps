// Import Center Completion (spec section 6): the ONE shared error
// classification surface for the Import Center. Every adapter's
// file-safety/parser rejection code (file-safety.ts, xlsx-parser.ts),
// every domain service error code (AnalyticsServiceErrorCode,
// FinanceAgreementsErrorResult / OnboardingBlockerCode), and every
// unclassified/system failure funnels through `classifyImportReasonCode`
// / `classifyServiceErrorCode` before it ever reaches an HTTP response or
// the client. Never expose a raw Firebase error, a stack trace, an auth
// uid, a raw doc id, or any sensitive value - a caller here supplies only
// a known, closed-list reason code plus an already-safe message; nothing
// here formats a caught exception's own text.

export const IMPORT_ERROR_CATEGORIES = ["FILE", "STRUCTURE", "ROW", "AUTHORIZATION", "SYSTEM"] as const;
export type ImportErrorCategory = (typeof IMPORT_ERROR_CATEGORIES)[number];

export type ClassifiedImportError = {
  category: ImportErrorCategory;
  code: string;
  message: string;
  // true when there is something the actor themselves can do right now
  // (fix the file, remap a column, request access) - false only for a
  // genuine system failure with nothing actionable but "try again later".
  correctable: boolean;
};

const FILE_LEVEL: Record<string, ImportErrorCategory> = {
  EMPTY_FILE: "FILE",
  FILE_TOO_LARGE: "FILE",
  MACRO_WORKBOOK_REJECTED: "FILE",
  MACRO_CONTENT_DETECTED: "FILE",
  UNSUPPORTED_EXTENSION: "FILE",
  UNSUPPORTED_MIME_TYPE: "FILE",
  UNREADABLE_WORKBOOK: "FILE",
  NO_SHEETS_FOUND: "FILE",
  ENCRYPTED_WORKBOOK: "FILE",
  CELL_VALUE_TOO_LARGE: "FILE",
  DECOMPRESSION_LIMIT_EXCEEDED: "FILE",
};

const STRUCTURE_LEVEL: Record<string, ImportErrorCategory> = {
  TOO_MANY_SHEETS: "STRUCTURE",
  TOO_MANY_ROWS: "STRUCTURE",
  REQUIRED_SHEET_MISSING: "STRUCTURE",
  DUPLICATE_HEADER: "STRUCTURE",
  UNSUPPORTED_TEMPLATE_VERSION: "STRUCTURE",
  MISSING_CHANNEL_PLATFORM: "STRUCTURE",
  RESTRICTED_FIELD_REJECTED: "STRUCTURE",
  REQUIRED_COLUMN_MISSING: "STRUCTURE",
};

// A reason code that is not correctable by the uploader themselves (a
// genuine system/internal condition masquerading as a reason code).
const NOT_CORRECTABLE = new Set(["INTERNAL_ERROR", "RESUME_FILE_MISMATCH"]);

export function classifyImportReasonCode(reasonCode: string, message: string): ClassifiedImportError {
  const category = FILE_LEVEL[reasonCode] ?? STRUCTURE_LEVEL[reasonCode] ?? (reasonCode === "INTERNAL_ERROR" ? "SYSTEM" : "ROW");
  return { category, code: reasonCode, message, correctable: !NOT_CORRECTABLE.has(reasonCode) };
}

// --- Analytics/Finance-Agreements service error codes ----------------------
export type ImportServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "conflict" | "internal";

export function classifyServiceErrorCode(code: ImportServiceErrorCode, message: string): ClassifiedImportError {
  switch (code) {
    case "unauthorized":
      return { category: "AUTHORIZATION", code: "ACTION_PERMISSION_DENIED", message, correctable: false };
    case "not_found":
      return { category: "AUTHORIZATION", code: "RECORD_SCOPE_DENIED", message, correctable: false };
    case "invalid_input":
      return { category: "ROW", code: "INVALID_INPUT", message, correctable: true };
    case "stale_write":
      return { category: "ROW", code: "STALE_CONFLICT_STATE", message, correctable: true };
    case "conflict":
      return { category: "ROW", code: "CONFLICT", message, correctable: true };
    case "internal":
    default:
      return { category: "SYSTEM", code: "INTERNAL_ERROR", message: "Something went wrong processing this import. Try again, or contact support if it keeps happening.", correctable: false };
  }
}

// --- Onboarding blocker codes (contract-bundle adapter) ---------------------
const ONBOARDING_BLOCKER_CATEGORY: Record<string, ImportErrorCategory> = {
  counterparty_create_not_permitted: "AUTHORIZATION",
  account_management_not_permitted: "AUTHORIZATION",
  strong_match_outside_access: "ROW",
  duplicate_acknowledgement_required: "ROW",
  duplicate_reason_required: "ROW",
  account_identity_collision: "ROW",
  use_existing_not_a_candidate: "ROW",
};

export function classifyOnboardingBlockerCode(code: string, message: string): ClassifiedImportError {
  const category = ONBOARDING_BLOCKER_CATEGORY[code] ?? "ROW";
  return { category, code, message, correctable: category !== "AUTHORIZATION" };
}

// A last-resort, generic, SAFE classification for a genuinely
// unclassified exception - never includes the exception's own message,
// name, or stack: only a fixed, safe sentence plus an optional
// correlation/request id (spec section 6's "System errors" bucket).
export function classifySystemError(requestId?: string | null): ClassifiedImportError {
  return {
    category: "SYSTEM",
    code: "UNCLASSIFIED_SYSTEM_ERROR",
    message: requestId ? `Something went wrong processing this import (reference ${requestId}). Try again, or contact support with this reference.` : "Something went wrong processing this import. Try again, or contact support if it keeps happening.",
    correctable: false,
  };
}
