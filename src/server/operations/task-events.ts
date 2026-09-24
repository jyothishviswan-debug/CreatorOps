import { randomUUID } from "node:crypto";

import { txCreateTaskEvent } from "./firestore";
import { TARGET_TYPES } from "./target-ref";
import { TASK_ORIGINS, TASK_PRIORITIES, TASK_STATUSES, TASK_VERSION_CHANGE_KINDS, taskEventSchema, type TaskEvent, type TaskEventKind } from "./types";

// Step 18A: the append-only Task audit trail (section 14). Mirrors
// src/server/finance-payments/payment-events.ts exactly: metadata is passed through an EXPLICIT
// ALLOWLIST - only the named keys below survive, and each only when its VALUE has the expected safe
// shape. No free-text field beyond a short, identity-shape-scrubbed note is ever representable.

type ValueCheck = (value: unknown) => boolean;

const isVersionNumber: ValueCheck = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1000;
const oneOf =
  (allowed: readonly string[]): ValueCheck =>
  (value) =>
    typeof value === "string" && allowed.includes(value);
const isOpaqueRef: ValueCheck = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const isIsoTimestamp: ValueCheck = (value) => typeof value === "string" && value.length > 0 && value.length <= 40;

const IDENTITY_SHAPED: RegExp[] = [
  /\b[A-Z]{5}\d{4}[A-Z]\b/i, // PAN
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/i, // IFSC
  /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/i, // GSTIN
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/, // Aadhaar
  /\d{9,}/, // any long digit run: account numbers, phone numbers, UTRs
  /[^\s@]+@[^\s@]+\.[^\s@]+/, // email address
  /(?:₹|\brs\.?|\binr\b|\busd\b|\$)\s*\d/i, // currency-prefixed amount
];
const isSafeNote: ValueCheck = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 1000 && !IDENTITY_SHAPED.some((pattern) => pattern.test(value));

export const TASK_EVENT_METADATA_ALLOWLIST: Readonly<Record<string, ValueCheck>> = {
  version: isVersionNumber,
  previousVersion: isVersionNumber,
  newVersion: isVersionNumber,
  fromStatus: oneOf(TASK_STATUSES),
  toStatus: oneOf(TASK_STATUSES),
  changeKind: oneOf(TASK_VERSION_CHANGE_KINDS),
  priority: oneOf(TASK_PRIORITIES),
  previousPriority: oneOf(TASK_PRIORITIES),
  origin: oneOf(TASK_ORIGINS),
  targetType: oneOf(TARGET_TYPES),
  targetRef: isOpaqueRef,
  previousAssigneeUserRef: isOpaqueRef,
  newAssigneeUserRef: isOpaqueRef,
  dueAt: isIsoTimestamp,
  previousDueAt: isIsoTimestamp,
  reason: isSafeNote,
};

export function redactTaskEventMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!Object.prototype.hasOwnProperty.call(TASK_EVENT_METADATA_ALLOWLIST, key)) continue;
    if (!TASK_EVENT_METADATA_ALLOWLIST[key]!(value)) continue;
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

export type TaskEventInput = { kind: TaskEventKind; version: number; actorUserRef: string; metadata: Record<string, unknown> | null; requestId: string; createdAt: string };

export function buildTaskEvent(input: TaskEventInput): TaskEvent {
  return taskEventSchema.parse({
    kind: input.kind,
    version: input.version,
    actorUserRef: input.actorUserRef,
    metadata: redactTaskEventMetadata(input.metadata),
    requestId: input.requestId,
    createdAt: input.createdAt,
  });
}

export function appendTaskEvent(tx: FirebaseFirestore.Transaction, taskRef: string, input: TaskEventInput): void {
  txCreateTaskEvent(tx, taskRef, randomUUID(), buildTaskEvent(input));
}
