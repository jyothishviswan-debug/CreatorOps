import type { OwnerType } from "@/server/notes-meetings/owner-registry";

// Deep-link builders (spec section 10). Every link is an app-relative path into a REAL, already-
// authorized single-item route - clicking it re-runs that destination's own authorization from
// scratch (this module grants nothing). Two known, disclosed gaps (documented in the completion
// report / continuity doc, not silently papered over):
//   - Notes/Meetings has no dedicated Meeting/ActionItem route or query-param deep-link convention
//     (it renders as an embedded tab on its owner record's own detail page - see
//     src/server/notes-meetings/owner-registry.ts). The honest deep link is the OWNER record's own
//     page, not a fabricated query param the UI does not read.
//   - Reports' `/reports/[reportId]` route takes only the catalog reportId, not a specific
//     runRef/version - ReportRunner.tsx has no query-param handling to pre-select a run. The deep
//     link lands on the report's catalog page, not the precise version.
export function taskDeepLink(taskRef: string): string {
  return `/operations/tasks/${encodeURIComponent(taskRef)}`;
}

export function contentDeepLink(contentRef: string): string {
  return `/content/${encodeURIComponent(contentRef)}`;
}

export function assignmentDeepLink(assignmentRef: string): string {
  return `/assignments/${encodeURIComponent(assignmentRef)}`;
}

export function reportDeepLink(reportId: string): string {
  return `/reports/${encodeURIComponent(reportId)}`;
}

const OWNER_TYPE_ROUTE_PREFIX: Partial<Record<OwnerType, string>> = {
  DISCOVERY_LEAD: "/discovery",
  PARTNER: "/partners",
  VENDOR: "/vendors",
  CAMPAIGN: "/campaigns",
  ASSIGNMENT: "/assignments",
  CONTENT: "/content",
};

// The Notes/Meetings owner record's own detail page - see the header comment above for why this is
// the honest deep link for a Meeting/ActionItem notification rather than a fabricated tab/query-param
// link. Returns null for an owner type with no known single-item route (a FUTURE owner type per the
// registry, which cannot occur for a SUPPORTED-only meeting/action-item today, but fails closed
// rather than guessing if it ever did).
export function meetingOwnerDeepLink(ownerType: string, ownerRef: string): string | null {
  const prefix = OWNER_TYPE_ROUTE_PREFIX[ownerType as OwnerType];
  if (!prefix) return null;
  return `${prefix}/${encodeURIComponent(ownerRef)}`;
}
