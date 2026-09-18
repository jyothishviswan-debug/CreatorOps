import type { AssignmentEventKind, AssignmentStatus } from "@/server/assignments/types";

export { relativeTime, absoluteTime } from "@/features/administration/format";

// Display labels only - the canonical status values themselves are never
// altered or re-derived here. Only the 5 real execution states - never
// Content-review states (Submitted/Approved/Revision requested/Posted/
// Published), which have no Assignment-backend equivalent.
export const STATUS_LABELS: Record<AssignmentStatus, string> = {
  DRAFT: "Draft",
  ASSIGNED: "Assigned",
  ACCEPTED: "Accepted",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

// The Assignment must actually be issued and still operational to be
// shareable via WhatsApp (Step 10C section 4 / Step 10C.1's own
// revalidation) - never DRAFT (nothing to share yet) or a terminal
// state. Shared by AssignmentDetail (header action visibility) and
// AssignmentShareDialog (final-confirmation revalidation), so the two
// checks can never drift apart.
export const SHARE_ELIGIBLE_STATUSES: AssignmentStatus[] = ["ASSIGNED", "ACCEPTED", "IN_PROGRESS"];

export function statusTone(status: AssignmentStatus): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (status === "IN_PROGRESS") return "default";
  if (status === "ASSIGNED") return "blue";
  if (status === "ACCEPTED") return "orange";
  if (status === "COMPLETED") return "purple";
  if (status === "CANCELLED") return "red";
  return "gray"; // DRAFT
}

const EVENT_LABELS: Record<AssignmentEventKind, string> = {
  created: "Assignment created",
  edited: "Brief edited",
  lifecycle_transitioned: "Lifecycle transitioned",
  cancelled: "Cancelled",
  external_submission_link_issued: "External submission link issued",
  external_submission_link_revoked: "External submission link revoked",
  external_links_submitted: "External links submitted",
};

export function eventLabel(kind: AssignmentEventKind): string {
  return EVENT_LABELS[kind] ?? kind;
}

// Display-only title-casing for a normalized platform identifier
// ("instagram" -> "Instagram") - the STORED value is never altered here.
export function platformLabel(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export function dateLabel(value: string): string {
  return value.length >= 10 ? value.slice(0, 10) : value;
}
