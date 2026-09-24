import { randomUUID } from "node:crypto";

import { txCreateReminderEvent } from "./firestore";
import { REMINDER_ORIGINS, REMINDER_STATUSES, reminderEventSchema, type ReminderEvent, type ReminderEventKind } from "./types";

// Step 18A: the append-only Reminder audit trail (section 14). Mirrors task-events.ts exactly.

type ValueCheck = (value: unknown) => boolean;

const oneOf =
  (allowed: readonly string[]): ValueCheck =>
  (value) =>
    typeof value === "string" && allowed.includes(value);
const isOpaqueRef: ValueCheck = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const isIsoTimestamp: ValueCheck = (value) => typeof value === "string" && value.length > 0 && value.length <= 40;
const isCount: ValueCheck = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;

const IDENTITY_SHAPED: RegExp[] = [
  /\b[A-Z]{5}\d{4}[A-Z]\b/i,
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/i,
  /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/i,
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/,
  /\d{9,}/,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /(?:₹|\brs\.?|\binr\b|\busd\b|\$)\s*\d/i,
];
const isSafeNote: ValueCheck = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 1000 && !IDENTITY_SHAPED.some((pattern) => pattern.test(value));

export const REMINDER_EVENT_METADATA_ALLOWLIST: Readonly<Record<string, ValueCheck>> = {
  fromStatus: oneOf(REMINDER_STATUSES),
  toStatus: oneOf(REMINDER_STATUSES),
  origin: oneOf(REMINDER_ORIGINS),
  reminderAt: isIsoTimestamp,
  previousReminderAt: isIsoTimestamp,
  rescheduleCount: isCount,
  taskRef: isOpaqueRef,
  approvalItemRef: isOpaqueRef,
  reason: isSafeNote,
};

export function redactReminderEventMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!Object.prototype.hasOwnProperty.call(REMINDER_EVENT_METADATA_ALLOWLIST, key)) continue;
    if (!REMINDER_EVENT_METADATA_ALLOWLIST[key]!(value)) continue;
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

export type ReminderEventInput = { kind: ReminderEventKind; actorUserRef: string; metadata: Record<string, unknown> | null; requestId: string; createdAt: string };

export function buildReminderEvent(input: ReminderEventInput): ReminderEvent {
  return reminderEventSchema.parse({ kind: input.kind, actorUserRef: input.actorUserRef, metadata: redactReminderEventMetadata(input.metadata), requestId: input.requestId, createdAt: input.createdAt });
}

export function appendReminderEvent(tx: FirebaseFirestore.Transaction, reminderRef: string, input: ReminderEventInput): void {
  txCreateReminderEvent(tx, reminderRef, randomUUID(), buildReminderEvent(input));
}
