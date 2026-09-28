// Safe notification copy (spec section 11/12). Every string shown to a recipient is built HERE,
// exclusively by these small templates - never assembled ad hoc at a projection call site, never a
// raw ref/uid/object path/storage ref/raw Firebase error, never KYC/bank/tax values, never full
// private Note text or full Meeting minutes, never sensitive report content. A caller only ever
// supplies an already-safe display string (a task title, a meeting title) that the OWNING module's
// own DTO layer already treats as safe to show to the people who can already see the record - a
// title is never restricted-body content.

const TITLE_MAX = 120;
const BODY_MAX = 240;

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export type NotificationCopy = { title: string; bodyPreview: string };

function copy(title: string, bodyPreview: string): NotificationCopy {
  return { title: truncate(title, TITLE_MAX), bodyPreview: truncate(bodyPreview, BODY_MAX) };
}

export const buildTaskAssignedCopy = (taskTitle: string): NotificationCopy => copy("Task assigned", `You were assigned "${taskTitle}".`);

export const buildTaskReassignedCopy = (taskTitle: string): NotificationCopy => copy("Task assigned to you", `You were assigned "${taskTitle}".`);

export const buildMeetingCreatedCopy = (meetingTitle: string): NotificationCopy => copy("Meeting scheduled", `You were added to "${meetingTitle}".`);

export const buildMeetingRevisedCopy = (meetingTitle: string): NotificationCopy => copy("Meeting updated", `"${meetingTitle}" was revised.`);

export const buildActionItemAssignedCopy = (actionItemText: string): NotificationCopy => copy("Meeting action item assigned", `You were assigned "${actionItemText}".`);

export const buildActionItemPromotedCopy = (taskTitle: string): NotificationCopy => copy("Meeting action item became a task", `"${taskTitle}" is now an Operations task assigned to you.`);

export const buildContentReviewDecisionCopy = (decision: "approved" | "revision_requested"): NotificationCopy =>
  decision === "approved" ? copy("Content approved", "A content review decision was made on an assignment you own.") : copy("Content revision requested", "A content review decision was made on an assignment you own.");

export const buildReportFinalizedCopy = (): NotificationCopy => copy("Report finalized", "A report you drafted was finalized.");

export const buildReportSupersededCopy = (): NotificationCopy => copy("Report superseded", "A report version you drafted was superseded by a newer finalized version.");

export const buildAssignmentCreatedCopy = (): NotificationCopy => copy("Assignment created", "A new assignment was created under a campaign you own.");
