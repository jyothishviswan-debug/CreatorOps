import type { AppliedExportFilters, ExportTargetDefinition, RawExportFilters } from "./types";

// Each target declares its own allowed filters server-side (ExportTargetDefinition.supportedFilters).
// A raw filters payload from the browser is never trusted beyond that declared allowlist - any key
// not present in supportedFilters is silently dropped (never interpreted, never an implicit grant).
// Mirrors src/server/reports/filters.ts exactly.
const MAX_FILTER_VALUE_LENGTH = 200;

export function parseAppliedExportFilters(raw: RawExportFilters | undefined, definition: ExportTargetDefinition): AppliedExportFilters {
  const applied: AppliedExportFilters = {};
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
