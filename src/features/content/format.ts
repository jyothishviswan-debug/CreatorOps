import type { ContentEventKind, ContentStatus } from "@/server/content/types";

export { relativeTime, absoluteTime } from "@/features/administration/format";

// Step 11B: display labels only - the canonical status values themselves
// are never altered or re-derived here. Mirrors Assignment's own
// format.ts idiom exactly. Order matches the task doc's own explicit
// status-filter label list.
export const STATUS_LABELS: Record<ContentStatus, string> = {
  PLANNED: "Planned",
  IN_PRODUCTION: "In production",
  SUBMITTED: "Submitted",
  CHANGES_REQUIRED: "Changes required",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  POSTED: "Posted",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export function statusTone(status: ContentStatus): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (status === "COMPLETED") return "purple";
  if (status === "CANCELLED" || status === "REJECTED") return "red";
  if (status === "CHANGES_REQUIRED") return "orange";
  if (status === "SUBMITTED" || status === "APPROVED" || status === "POSTED") return "blue";
  return "gray"; // PLANNED, IN_PRODUCTION
}

const EVENT_LABELS: Record<ContentEventKind, string> = {
  created: "Content created",
  production_started: "Production started",
  version_saved: "Version saved",
  submitted: "Submitted for review",
  review_decision: "Review decision recorded",
  publication_evidence_added: "Publication evidence added",
  posted: "Posted",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function eventLabel(kind: ContentEventKind): string {
  return EVENT_LABELS[kind] ?? kind;
}

// Display-only title-casing for a normalized platform identifier
// ("instagram" -> "Instagram") - the STORED value is never altered here.
// Same idiom as Assignment's own platformLabel.
export function platformLabel(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

// Same title-casing treatment for a Content type identifier ("reel" ->
// "Reel") - contentType is a bounded free-text field (1-60 chars), not an
// enum, so this is purely cosmetic capitalization, never validation.
export function contentTypeLabel(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export function dateLabel(value: string): string {
  return value.length >= 10 ? value.slice(0, 10) : value;
}

// A safe, real, derived-from-data display label for a Content record -
// never a raw ref. Used identically by the Workspace row label and the
// Detail header, so the two never drift apart.
export function contentDisplayTitle(content: { title: string | null; contentType: string; platform: string }): string {
  return content.title ?? `${contentTypeLabel(content.contentType)} · ${platformLabel(content.platform)}`;
}
