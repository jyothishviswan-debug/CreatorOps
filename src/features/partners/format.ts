import type { PartnerEventKind, PartnerStatus } from "@/server/partners/types";

export { relativeTime, absoluteTime } from "@/features/administration/format";

// Display labels only - the canonical status values themselves are never
// altered or re-derived here.
export const STATUS_LABELS: Record<PartnerStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  BLACKLISTED: "Blacklisted",
  ARCHIVED: "Archived",
};

export function statusTone(status: PartnerStatus): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (status === "ACTIVE") return "default";
  if (status === "INACTIVE") return "gray";
  if (status === "BLACKLISTED") return "red";
  return "gray";
}

const EVENT_LABELS: Record<PartnerEventKind, string> = {
  created: "Partner created",
  edited: "Partner details edited",
  owner_team_changed: "Owner/team changed",
  status_changed: "Status changed",
  blacklisted: "Blacklisted",
  archived: "Archived",
  restored: "Restored",
  account_created: "Partner Account created",
  account_edited: "Partner Account edited",
  account_identity_changed: "Partner Account identity changed",
  account_status_changed: "Partner Account status changed",
  primary_account_changed: "Primary account changed",
  restricted_identity_saved: "Restricted identity saved",
};

export function eventLabel(kind: PartnerEventKind): string {
  return EVENT_LABELS[kind] ?? kind;
}
