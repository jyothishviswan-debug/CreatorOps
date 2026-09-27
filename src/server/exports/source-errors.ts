import type { ExportsDenialReason, ExportsErrorResult } from "./types";

// Maps ANY other module's own `{ok:false, code, message, reason?}` result into an Export Center
// error - mirrors src/server/reports/source-errors.ts exactly (same "never leak a foreign module's
// own internal denial vocabulary" discipline).
const KNOWN_REASONS: ReadonlySet<string> = new Set(["not_authenticated", "feature_denied", "action_denied", "scope_denied"]);

function normalizeReason(reason: unknown): ExportsDenialReason {
  return typeof reason === "string" && KNOWN_REASONS.has(reason) ? (reason as ExportsDenialReason) : "scope_denied";
}

export function mapSourceError(source: { code: string; message: string; reason?: unknown }): ExportsErrorResult {
  if (source.code === "unauthorized") return { ok: false, code: "unauthorized", message: source.message, reason: normalizeReason(source.reason) };
  // A source's own "invalid_input" (e.g. a malformed periodKey/status filter value it validates
  // itself, like Partner Reviews' own derivePeriod check) is a genuine, actionable CONFIGURATION
  // error (section 11) - surfaced as exactly that, never mislabeled as "source unavailable", which
  // would wrongly suggest a transient outage the user cannot fix by correcting their own filter value.
  if (source.code === "invalid_input") return { ok: false, code: "invalid_input", message: source.message };
  return { ok: false, code: "source_unavailable", message: `Source unavailable: ${source.message}` };
}
