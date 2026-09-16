import type { LeadEventKind, LeadLifecycle, ReviewOutcome } from "@/server/discovery/types";

export { relativeTime, absoluteTime } from "@/features/administration/format";

// Display labels only - the canonical lifecycle values themselves are
// never altered or re-derived here (see authz/lifecycle.ts).
export const LIFECYCLE_LABELS: Record<LeadLifecycle, string> = {
  NEW: "New",
  RESEARCHING: "Researching",
  CONTACTED: "Contacted",
  RESPONDED: "Responded",
  EVALUATING: "Evaluating",
  CONVERSION_READY: "Conversion ready",
  CONVERTED: "Converted",
  WATCHLIST: "Watchlist",
  REJECTED: "Rejected",
  DUPLICATE: "Duplicate",
  ARCHIVED: "Archived",
};

export function lifecycleTone(lifecycle: LeadLifecycle): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (lifecycle === "CONVERTED") return "default";
  if (lifecycle === "CONVERSION_READY") return "blue";
  if (lifecycle === "REJECTED" || lifecycle === "DUPLICATE") return "red";
  if (lifecycle === "WATCHLIST" || lifecycle === "ARCHIVED") return "gray";
  if (lifecycle === "NEW") return "gray";
  return "orange";
}

export const REVIEW_OUTCOME_LABELS: Record<ReviewOutcome, string> = {
  SHORTLIST: "Shortlist",
  NEED_MORE_INFO: "Need more information",
  WATCHLIST: "Watch list",
  REJECT: "Reject",
};

const EVENT_LABELS: Record<LeadEventKind, string> = {
  created: "Lead created",
  edited: "Lead details edited",
  lifecycle_transitioned: "Lifecycle changed",
  lifecycle_restored: "Lead restored",
  research_saved: "Research saved",
  review_recorded: "Review recorded",
  outreach_recorded: "Outreach recorded",
  commercial_saved: "Commercial evidence saved",
  agreement_saved: "Agreement evidence saved",
  asset_decision_saved: "Asset decision saved",
  manager_assigned: "Manager assignment changed",
  kyc_updated: "KYC package updated",
  duplicate_checked: "Duplicate check run",
  converted: "Converted to Partner",
};

export function eventLabel(kind: LeadEventKind): string {
  return EVENT_LABELS[kind] ?? kind;
}
