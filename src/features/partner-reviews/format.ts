import type { CSSProperties } from "react";

import { absoluteTime, relativeTime } from "@/features/administration/format";
import { platformLabel } from "@/features/content/format";
import type { PartnerReviewEventKind, PartnerReviewFreshnessState, PartnerReviewStatus } from "@/server/partner-reviews/types";
import type { ReviewRowLifecycle } from "@/server/partner-reviews/ui-dto";
import type { WorkspaceSignal } from "@/server/partner-reviews/ui-params";

import { COMMERCIAL_CONFLICT_SECTION_REASON } from "./commercial-conflict";

export { absoluteTime, relativeTime, platformLabel };

// Step 13B: display-only labels and tones for Partner Reviews. Nothing here changes a stored value;
// canonical terminology only (Partner Reviews / Monthly reviews / Assignments received / Qualifying
// content / Finalized reviews).

export type PillTone = "default" | "orange" | "blue" | "purple" | "red" | "gray";

export const LIFECYCLE_LABELS: Record<ReviewRowLifecycle | PartnerReviewStatus, string> = {
  NEEDS_REVIEW: "Needs review",
  DRAFT: "Draft",
  IN_REVIEW: "In review",
  FINALIZED: "Finalized",
  SUPERSEDED: "Superseded",
};

export function lifecycleTone(state: ReviewRowLifecycle | PartnerReviewStatus): PillTone {
  if (state === "NEEDS_REVIEW") return "orange";
  if (state === "DRAFT") return "gray";
  if (state === "IN_REVIEW") return "blue";
  if (state === "SUPERSEDED") return "gray";
  return "default";
}

export const FRESHNESS_LABELS: Record<PartnerReviewFreshnessState, string> = {
  current: "Current",
  refresh_available: "Refresh available",
  revision_available: "Revision available",
  revision_in_progress: "Revision in progress",
  evidence_incomplete: "Evidence incomplete",
  superseded: "Superseded",
};

export function freshnessTone(state: PartnerReviewFreshnessState): PillTone {
  if (state === "current") return "default";
  if (state === "refresh_available" || state === "revision_available") return "orange";
  if (state === "evidence_incomplete") return "blue";
  return "gray";
}

export const EVENT_LABELS: Record<PartnerReviewEventKind, string> = {
  generated: "Review generated",
  refreshed: "Evidence refreshed",
  submitted: "Submitted for review",
  finalized: "Review finalized",
  revision_created: "Revision created",
  superseded: "Review superseded",
};

export const SIGNAL_LABELS: Record<WorkspaceSignal, string> = {
  stale: "Stale evidence",
  revision_available: "Review revision available",
  missing_evidence: "Missing evidence",
  late: "Late submissions",
  target_not_met: "Agreement target not met",
  requirement_unavailable: "Commercial requirement unavailable",
  lfc_sfc_unavailable: "LFC/SFC rule unavailable",
};

// Typed incomplete-reason codes (never free text) -> plain language.
export const INCOMPLETE_REASON_LABELS: Record<string, string> = {
  assignment_scan_truncated: "The Assignment read reached its bound, so some Assignments may be missing.",
  assignments_in_period_truncated: "More Assignments fall in this month than one review holds.",
  analytics_scan_truncated: "The Analytics read reached its bound, so some source records may be missing.",
  analytics_records_in_period_truncated: "More Analytics records fall in this month than one review holds.",
  approved_content_without_analytics: "Some approved Content has no matched Analytics evidence yet.",
  analytics_records_without_reporting_period: "Some Analytics records carry no reporting period and are not placed in any month.",
  analytics_records_with_unparseable_reporting_period: "Some Analytics records carry a reporting period that could not be read.",
};

export function incompleteReasonLabel(code: string): string {
  return INCOMPLETE_REASON_LABELS[code] ?? "Some evidence could not be completed.";
}

// Typed unavailable-reason codes of the commercial evidence -> plain language.
const UNAVAILABLE_REASON_LABELS: Record<string, string> = {
  no_agreement_requirement: "No Agreement supplies a monthly qualifying-content requirement.",
  no_agreement_rule: "No Agreement supplies an LFC/SFC rule.",
  unsupported_qualifying_unit: "The Agreement's qualifying unit is not supported here.",
  evidence_truncated: "The evidence read was bounded, so the count is not reliable.",
  no_verified_values: "No verified source value was reported.",
  incomplete_metric_coverage: "Some records did not report the metric, so the target cannot be judged.",
  insufficient_follower_snapshots: "Growth needs at least two comparable verified snapshots.",
  conflicting_follower_snapshots: "Comparable snapshots conflict, so growth is not judged.",
  channel_scan_truncated: "The channel snapshot read was bounded.",
  unsupported_metric: "This metric is not supported as an Analytics target.",
  multiple_applicable_agreements: COMMERCIAL_CONFLICT_SECTION_REASON,
};

export function unavailableReasonLabel(code: string | null): string | null {
  if (code === null) return null;
  return UNAVAILABLE_REASON_LABELS[code] ?? "Unavailable.";
}

export const TARGET_METRIC_LABELS: Record<string, string> = {
  views: "Views",
  likes: "Likes",
  comments: "Comments",
  engagement: "Engagement (source-reported)",
  profileFollowers: "Profile followers",
  followerGrowth: "Follower growth",
  reach: "Reach",
};

export function targetMetricLabel(metricId: string): string {
  return TARGET_METRIC_LABELS[metricId] ?? metricId;
}

export function formatCount(value: number | null): string {
  return value === null ? "Unavailable" : value.toLocaleString("en-GB");
}

export const COMMERCIAL_EVIDENCE_LABEL = "Used as commercial evidence";
export const TARGET_MONITORING_LABEL = "Target monitoring only · does not affect payment";

// Date-only display of an ISO instant ("14 Sep 2026").
export function dateOnly(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
}

// The visibly-disabled treatment, applied LOCALLY as an inline style only while a button is `disabled` -
// the same treatment CreateAssignmentDialog uses (there is deliberately no global `.btn:disabled` rule).
// #5a6572 on #eceff2 = 5.14:1 contrast (>= 4.5:1). Inline `background` also beats the stylesheet's hover rules.
export const DISABLED_BUTTON_STYLE: CSSProperties = { background: "#eceff2", borderColor: "#d5dae0", color: "#5a6572", cursor: "not-allowed" };
