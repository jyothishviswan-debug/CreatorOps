import type { CampaignEventKind, CampaignResourceType, CampaignStatus, ReviewPolicy } from "@/server/campaigns/types";

export { relativeTime, absoluteTime } from "@/features/administration/format";

// Display labels only - the canonical status values themselves are never
// altered or re-derived here.
export const STATUS_LABELS: Record<CampaignStatus, string> = {
  DRAFT: "Draft",
  PLANNED: "Planned",
  ACTIVE: "Active",
  PAUSED: "Paused",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  ARCHIVED: "Archived",
};

export function statusTone(status: CampaignStatus): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (status === "ACTIVE") return "default";
  if (status === "PLANNED") return "blue";
  if (status === "PAUSED") return "orange";
  if (status === "COMPLETED") return "purple";
  if (status === "CANCELLED" || status === "ARCHIVED") return "red";
  return "gray"; // DRAFT
}

export const REVIEW_POLICY_LABELS: Record<ReviewPolicy, string> = {
  REVIEW_REQUIRED: "Review required before publishing",
  NO_PREPOST_REVIEW: "No pre/post review required",
};

export const RESOURCE_TYPE_LABELS: Record<CampaignResourceType, string> = {
  LINK: "Link",
  DOCUMENT: "Document",
  BRIEF: "Brief",
  ASSET: "Asset",
  OTHER: "Other",
};

const EVENT_LABELS: Record<CampaignEventKind, string> = {
  created: "Campaign created",
  edited: "Plan edited",
  owner_team_changed: "Owner/team changed",
  default_review_policy_changed: "Default review policy changed",
  resource_added: "Resource added",
  resource_edited: "Resource edited",
  resource_removed: "Resource removed",
  lifecycle_transitioned: "Lifecycle transitioned",
  cancelled: "Cancelled",
  archived: "Archived",
};

export function eventLabel(kind: CampaignEventKind): string {
  return EVENT_LABELS[kind] ?? kind;
}

// Display-only title-casing for a normalized platform identifier
// ("instagram" -> "Instagram") - the STORED value is never altered here,
// this only ever affects how it's rendered.
export function platformLabel(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export function dateLabel(value: string): string {
  return value.length >= 10 ? value.slice(0, 10) : value;
}
