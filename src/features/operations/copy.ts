import type { TargetType } from "@/server/operations/target-ref";
import type { TaskPriority, TaskStatus, ReminderEffectiveStatus } from "@/server/operations/types";
import type { ApprovalSourceModule } from "@/server/operations/approval-queue/types";

// Step 18B: display-only labels/tones for the closed enums Step 18A publishes. Never re-derives a
// status - only maps an already-authoritative value to copy/tone for the UI.

export type PillTone = "default" | "orange" | "blue" | "purple" | "red" | "gray";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

export const TASK_STATUS_TONE: Record<TaskStatus, PillTone> = {
  OPEN: "blue",
  IN_PROGRESS: "purple",
  BLOCKED: "red",
  DONE: "default",
  CANCELLED: "gray",
};

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
};

export const TASK_PRIORITY_TONE: Record<TaskPriority, PillTone> = {
  LOW: "gray",
  NORMAL: "blue",
  HIGH: "orange",
  URGENT: "red",
};

export type DueState = "no_due_date" | "due_today" | "due_soon" | "overdue" | "scheduled";
export const DUE_STATE_LABEL: Record<DueState, string> = {
  no_due_date: "No due date",
  due_today: "Due today",
  due_soon: "Due soon",
  overdue: "Overdue",
  scheduled: "Scheduled",
};
export const DUE_STATE_TONE: Record<DueState, PillTone> = {
  no_due_date: "gray",
  due_today: "orange",
  due_soon: "blue",
  overdue: "red",
  scheduled: "default",
};

const DUE_SOON_WINDOW_MS = 1000 * 60 * 60 * 48; // 48h

// Derived purely from already-loaded fields (dueAt + status), same discipline as the server's own
// `isOverdue` - never re-decides overdue itself, only adds the "due today"/"due soon" bands on top
// of it for display.
export function deriveDueState(input: { dueAt: string | null; isOverdue: boolean; status: TaskStatus }, nowIso: string): DueState {
  if (input.dueAt === null) return "no_due_date";
  if (input.status === "DONE" || input.status === "CANCELLED") return "scheduled";
  if (input.isOverdue) return "overdue";
  const due = new Date(input.dueAt).getTime();
  const now = new Date(nowIso).getTime();
  if (Number.isNaN(due) || Number.isNaN(now)) return "scheduled";
  const sameDay = new Date(input.dueAt).toDateString() === new Date(nowIso).toDateString();
  if (sameDay) return "due_today";
  if (due - now <= DUE_SOON_WINDOW_MS) return "due_soon";
  return "scheduled";
}

export const REMINDER_STATUS_LABEL: Record<ReminderEffectiveStatus, string> = {
  SCHEDULED: "Scheduled",
  DUE: "Due",
  DISMISSED: "Dismissed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const REMINDER_STATUS_TONE: Record<ReminderEffectiveStatus, PillTone> = {
  SCHEDULED: "blue",
  DUE: "orange",
  DISMISSED: "gray",
  COMPLETED: "default",
  CANCELLED: "gray",
};

export const TARGET_TYPE_LABEL: Record<TargetType, string> = {
  PARTNER: "Partner",
  PARTNER_ACCOUNT: "Partner Account",
  VENDOR: "Vendor",
  CAMPAIGN: "Campaign",
  ASSIGNMENT: "Assignment",
  CONTENT: "Content",
  PARTNER_REVIEW: "Partner Review",
  AGREEMENT: "Agreement",
  PAYABLE: "Payable",
  INVOICE: "Invoice",
  PAYMENT: "Payment",
};

export const APPROVAL_SOURCE_LABEL: Record<ApprovalSourceModule, string> = {
  partner_reviews: "Partner Review",
  finance_payables: "Payable",
  finance_invoices: "Invoice",
  finance_payments: "Payment",
};

// Step 18C: a fixed locale, never `undefined` - `undefined` resolves to the running environment's
// own default locale, which differs between the Node.js server (SSR) and the browser (hydration),
// producing two different formatted strings for the exact same instant and a genuine React hydration
// mismatch (observed live on a Task detail page's "Created"/"Updated" fields during Step 18C's own
// browser certification pass: server rendered "24 Sept 2026, 23:14", client rehydrated to
// "Sep 24, 2026, 11:14 PM"). "en-GB" matches the SAME fix already applied for this exact reason
// elsewhere in the app - see src/features/administration/format.ts's own DATE_LOCALE constant.
const DATE_LOCALE = "en-GB";

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(DATE_LOCALE, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatDateTimeInputValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Step 18B follow-up: a safe display name resolved server-side always wins over the raw ref - the
// raw ref is only ever a fallback for a lookup that failed (a since-removed user), never the
// primary label.
export function displayNameOrRef(displayName: string | null | undefined, ref: string): string {
  return displayName?.trim() || ref;
}

export function toIsoFromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
