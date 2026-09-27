export { absoluteTime, relativeTime } from "@/features/administration/format";

import type { ActionItemStatus, MeetingStatus, NoteStatus } from "@/server/notes-meetings";

export const NOTE_STATUS_LABELS: Record<NoteStatus, string> = { ACTIVE: "Active", ARCHIVED: "Archived" };
export const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = { SCHEDULED: "Scheduled", COMPLETED: "Completed", CANCELLED: "Cancelled" };
export const ACTION_ITEM_STATUS_LABELS: Record<ActionItemStatus, string> = { OPEN: "Open", IN_PROGRESS: "In progress", DONE: "Done", CANCELLED: "Cancelled" };

export function meetingStatusTone(status: MeetingStatus): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (status === "SCHEDULED") return "blue";
  if (status === "COMPLETED") return "default";
  return "gray";
}

export function actionItemStatusTone(status: ActionItemStatus): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  if (status === "OPEN") return "orange";
  if (status === "IN_PROGRESS") return "blue";
  if (status === "DONE") return "default";
  return "gray";
}

export function noteStatusTone(status: NoteStatus): "default" | "orange" | "blue" | "purple" | "red" | "gray" {
  return status === "ACTIVE" ? "default" : "gray";
}

export function formatDateTimeLocal(iso: string): string {
  // For a <input type="datetime-local"> value from an ISO timestamp.
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
