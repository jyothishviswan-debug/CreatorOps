import type { ReportsDenialReason, ReportsErrorResult } from "./types";

// Step 19A: every family projector composes several source modules, each with its OWN denial-reason
// union (Campaigns/Assignments/Content/Analytics/Partner Reviews/Finance/Operations/Discovery/
// Partners/Administration each define their own XDenialReason type, several of which carry values
// Reports' own ReportsDenialReason does not - e.g. "sensitive_denied", "not_active"). Rather than
// widen Reports' own denial vocabulary to match every source module's internal detail (leaking
// implementation-specific denial granularity the browser has no use for - section 8's own "never says
// which layer failed beyond this" discipline, same as every module's own toXHttpResponse), this
// normalizes ANY unrecognized source denial reason down to "scope_denied" - still a 403, still an
// honest "you may not see this", just without echoing a foreign module's own internal vocabulary.
const KNOWN_REASONS: ReadonlySet<string> = new Set(["not_authenticated", "feature_denied", "action_denied", "scope_denied"]);

function normalizeReason(reason: unknown): ReportsDenialReason {
  return typeof reason === "string" && KNOWN_REASONS.has(reason) ? (reason as ReportsDenialReason) : "scope_denied";
}

// Maps ANY other module's own `{ok:false, code, message, reason?}` result into a Reports-level
// error. An `unauthorized` source denial becomes a Reports `unauthorized` denial (never leaked as
// "source_unavailable", which is reserved for a genuine technical/availability problem); every other
// source error code (not_found, invalid_input, stale_write, conflict, not_ready, internal, ...)
// becomes "source_unavailable" - Reports itself never asserts a more specific claim about a foreign
// module's own internal error taxonomy than "this report's required source could not be read".
export function mapSourceError(source: { code: string; message: string; reason?: unknown }): ReportsErrorResult {
  if (source.code === "unauthorized") return { ok: false, code: "unauthorized", message: source.message, reason: normalizeReason(source.reason) };
  return { ok: false, code: "source_unavailable", message: `Source unavailable: ${source.message}` };
}
