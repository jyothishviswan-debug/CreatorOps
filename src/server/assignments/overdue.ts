import type { AssignmentDto } from "./client-dto";

// Findings #42/#51 (user-decided): the ONE shared "is this Assignment overdue" predicate for report rows
// - campaign-delivery.ts and campaign-event-performance.ts each carried their own identical inline copy
// (exactly the kind of drift this program keeps finding and closing). Only an IN_PROGRESS Assignment can
// be overdue: new Assignments now skip DRAFT/ASSIGNED/ACCEPTED entirely, and a legacy Assignment
// stranded in one of those states isn't active, delayed work - it needs its own narrow recovery action,
// never a report-level "overdue" flag. This is the same tightening execution-integration-service.ts's own
// isObligationOverdue makes (from "not COMPLETED/CANCELLED" to "must BE IN_PROGRESS" - strictly
// narrower, since DRAFT/ASSIGNED/ACCEPTED could previously also count).
export function isAssignmentOverdue(assignment: Pick<AssignmentDto, "status" | "brief">, nowIso: string): boolean {
  return assignment.brief.dueAt !== null && assignment.brief.dueAt < nowIso && assignment.status === "IN_PROGRESS";
}
