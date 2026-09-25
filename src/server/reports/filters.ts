import type { AppliedReportFilters, RawReportFilters, ReportDefinition } from "./types";

// Step 19A section 7: each report declares its own allowed filters server-side
// (ReportDefinition.supportedFilters). A raw filters payload from the browser is never trusted
// beyond that declared allowlist - any key not present in supportedFilters is silently dropped
// (never interpreted, never an error - an unknown filter id can never grant access, section 7's own
// "Requested IDs never grant access"). Every accepted value is coerced to a plain, bounded string;
// nothing here ever becomes a Firestore field name, collection name, or query operator - the actual
// narrowing happens entirely in-memory over an already actor-scoped, already-bounded result set (see
// families/*.ts), never as a second Firestore filter Reports invents on its own.
const MAX_FILTER_VALUE_LENGTH = 200;

export function parseAppliedFilters(raw: RawReportFilters | undefined, definition: ReportDefinition): AppliedReportFilters {
  const applied: AppliedReportFilters = {};
  if (!raw || typeof raw !== "object") return applied;
  const allowedIds = new Set(definition.supportedFilters.map((filter) => filter.id));
  for (const [key, value] of Object.entries(raw)) {
    if (!allowedIds.has(key)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_FILTER_VALUE_LENGTH) continue;
    applied[key] = trimmed;
  }
  return applied;
}
