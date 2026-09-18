// Step 12B: pure, unit-testable display helpers for the Analytics UI.
// Mirrors content/format.ts's/assignments/format.ts's own idiom exactly
// - display labels only, never re-derives a stored value.
export { relativeTime, absoluteTime } from "@/features/administration/format";
export { platformLabel } from "@/features/content/format";

// src/ui/Badge.tsx's own PillTone union isn't exported - mirrored here
// (same literal set) rather than widening Badge's own public contract.
export type PillTone = "default" | "orange" | "blue" | "purple" | "red" | "gray";

export type AnalyticsMatchState = "MATCHED" | "UNMATCHED" | "AMBIGUOUS";

const MATCH_STATE_LABELS: Record<AnalyticsMatchState, string> = {
  MATCHED: "Matched",
  UNMATCHED: "Unmatched",
  AMBIGUOUS: "Ambiguous",
};

export function matchStateLabel(state: AnalyticsMatchState): string {
  return MATCH_STATE_LABELS[state] ?? state;
}

// Matched reads as a real positive signal (green/default); Unmatched is
// neutral (gray, not yet resolved - never red, which this app reserves
// for a blocked/denied state); Ambiguous reads as needing attention
// (orange), same tone family Checks/Pills already use for "needs review"
// elsewhere in this app.
export function matchStateTone(state: AnalyticsMatchState): PillTone {
  if (state === "MATCHED") return "default";
  if (state === "AMBIGUOUS") return "orange";
  return "gray";
}

const BATCH_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  DRY_RUN_ONLY: "Dry run only",
  COMPLETED: "Completed",
  COMPLETED_WITH_ERRORS: "Completed with errors",
  FAILED: "Failed",
};

export function batchStatusLabel(status: string): string {
  return BATCH_STATUS_LABELS[status] ?? status;
}

export function batchStatusTone(status: string): PillTone {
  if (status === "COMPLETED") return "default";
  if (status === "COMPLETED_WITH_ERRORS") return "orange";
  if (status === "FAILED") return "red";
  if (status === "DRY_RUN_ONLY") return "purple";
  return "gray"; // PENDING
}

export function recordKindLabel(kind: "content" | "channel"): string {
  return kind === "content" ? "Content analytics" : "Channel analytics";
}

export function targetKindLabel(kind: string): string {
  return kind === "campaign_content" ? "Campaign content" : kind === "channel_account" ? "Channel account" : kind;
}

// A safe, truncated display form of a source revision hash - never the
// literal full hex value (which reads like a technical secret even
// though it isn't one), never claimed to be one either.
export function shortHash(hash: string): string {
  return hash.length <= 12 ? hash : `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

// "Unavailable"/"—" for a missing metric value - real zero always stays
// the literal `0`, never hidden or confused with "missing" (Section 27).
export function formatMetric(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-GB");
}

export function reportingPeriodLabel(period: { start: string; end: string } | null): string {
  return period ? `${period.start} – ${period.end}` : "Unknown period";
}
