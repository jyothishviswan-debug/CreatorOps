import type { ContentEventKind, ContentStatus } from "@/server/content/types";

export { relativeTime, absoluteTime } from "@/features/administration/format";

// Step 11A.1: display labels only - the canonical status values
// themselves are never altered or re-derived here. Mirrors Assignment's
// own format.ts idiom exactly.
export const STATUS_LABELS: Record<ContentStatus, string> = {
  OPEN: "Open",
  UNDER_REVIEW: "Under review",
  REVISION_REQUESTED: "Revision requested",
  APPROVED: "Approved",
  CANCELLED: "Cancelled",
};

export function statusTone(status: ContentStatus): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (status === "APPROVED") return "purple";
  if (status === "CANCELLED") return "red";
  if (status === "REVISION_REQUESTED") return "orange";
  if (status === "UNDER_REVIEW") return "blue";
  return "gray"; // OPEN
}

const EVENT_LABELS: Record<ContentEventKind, string> = {
  created: "Submission thread created",
  submitted: "Links submitted",
  approved: "Approved",
  revision_requested: "Revision requested",
  cancelled: "Cancelled",
};

export function eventLabel(kind: ContentEventKind): string {
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

// A safe, real, derived-from-data display label for a Content thread -
// never a raw ref. Step 11A.1: there is no fixed contentType/platform/
// title at the thread root anymore (links carry their own platform per
// row) - derive a truthful label from the current links instead. Used
// identically by the Workspace row label and the Detail header, so the
// two never drift apart.
export function contentDisplayTitle(content: { currentLinks: { platform: string }[]; currentRevisionNumber: number }): string {
  if (content.currentLinks.length === 0) return "Submission thread (no links yet)";
  const platforms = [...new Set(content.currentLinks.map((l) => platformLabel(l.platform)))];
  const linkWord = content.currentLinks.length === 1 ? "link" : "links";
  return `${platforms.join(", ")} · ${content.currentLinks.length} ${linkWord} (rev ${content.currentRevisionNumber})`;
}
