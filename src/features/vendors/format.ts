import type { RelationshipType, VendorEventKind, VendorPartnerLinkStatus, VendorStatus, VendorType } from "@/server/vendors/types";

export { relativeTime, absoluteTime } from "@/features/administration/format";

// Display labels only - the canonical status values themselves are never
// altered or re-derived here.
export const STATUS_LABELS: Record<VendorStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  ARCHIVED: "Archived",
};

export function statusTone(status: VendorStatus): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (status === "ACTIVE") return "default";
  if (status === "INACTIVE") return "gray";
  return "gray";
}

export const VENDOR_TYPE_LABELS: Record<VendorType, string> = {
  AGENCY: "Agency",
  MANAGEMENT_COMPANY: "Management company",
  MANAGER_REPRESENTATIVE: "Manager / representative",
  PAYEE_BUSINESS: "Payee business",
  OTHER: "Other",
};

export const RELATIONSHIP_TYPE_LABELS: Record<RelationshipType, string> = {
  REPRESENTATION: "Representation",
  MANAGEMENT: "Management",
  AGENCY: "Agency",
  PAYEE: "Payee",
  OTHER: "Other",
};

export const LINK_STATUS_LABELS: Record<VendorPartnerLinkStatus, string> = {
  ACTIVE: "Active",
  ENDED: "Ended",
};

export function linkStatusTone(status: VendorPartnerLinkStatus): "default" | "gray" {
  return status === "ACTIVE" ? "default" : "gray";
}

const EVENT_LABELS: Record<VendorEventKind, string> = {
  created: "Vendor created",
  edited: "Vendor details edited",
  owner_team_changed: "Owner/team changed",
  status_changed: "Status changed",
  archived: "Archived",
  restored: "Restored",
  link_created: "Partner relationship created",
  link_edited: "Partner relationship edited",
  link_ended: "Partner relationship ended",
  link_restored: "Partner relationship restored",
  restricted_identity_saved: "Restricted identity saved",
};

export function eventLabel(kind: VendorEventKind): string {
  return EVENT_LABELS[kind] ?? kind;
}

// effectiveFrom/effectiveTo are stored as opaque non-empty strings (a
// legacy seed fixture may hold a full ISO timestamp; the create/edit
// form only ever writes a plain YYYY-MM-DD from its <input type="date">)
// - this only ever trims DISPLAY, the stored value itself is never
// altered or reparsed.
export function effectiveDateLabel(value: string): string {
  return value.length >= 10 ? value.slice(0, 10) : value;
}
