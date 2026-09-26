import type { ExportTargetDefinition } from "./types";

// Server-authoritative column validation (the spec's own core requirement: "the client may request a
// subset of supported columns, but the server must validate the final allowed set"). A raw column
// list from the browser is never passed through to a generator - every id is checked against the
// target's own explicit `columns` allowlist (catalog.ts), duplicates are collapsed, and an unknown/
// malformed/restricted id causes the WHOLE request to be rejected (never silently dropped-and-
// continued, which could make a client believe a column was honored when it was not).
export type ColumnValidationResult = { ok: true; columnIds: string[] } | { ok: false; message: string };

export function validateRequestedColumns(definition: ExportTargetDefinition, rawColumns: unknown): ColumnValidationResult {
  const allowedIds = new Set(definition.columns.map((c) => c.id));

  if (rawColumns === undefined) {
    // No explicit selection -> the target's own safe default columns.
    return { ok: true, columnIds: [...definition.defaultColumnIds] };
  }

  if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
    return { ok: false, message: "columns must be a non-empty array of column ids." };
  }
  if (rawColumns.length > definition.columns.length) {
    return { ok: false, message: "Too many columns requested." };
  }

  const seen = new Set<string>();
  for (const raw of rawColumns) {
    if (typeof raw !== "string" || raw.length === 0) return { ok: false, message: "Every requested column must be a non-empty string." };
    if (!allowedIds.has(raw)) return { ok: false, message: `Column "${raw}" is not a supported column for this export target.` };
    if (seen.has(raw)) return { ok: false, message: `Column "${raw}" was requested more than once.` };
    seen.add(raw);
  }

  // Deterministic order: always the catalog's own declared column order, never the client-supplied
  // order - keeps generated-file column order stable/reviewable regardless of what the request body
  // happened to list first.
  const columnIds = definition.columns.map((c) => c.id).filter((id) => seen.has(id));
  return { ok: true, columnIds };
}
