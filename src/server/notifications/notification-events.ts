import { randomUUID } from "node:crypto";

import { txCreateNotificationEvent } from "./firestore";
import { NOTIFICATION_SOURCE_DOMAINS, NOTIFICATION_TYPES, notificationEventSchema, type NotificationEvent, type NotificationEventKind } from "./types";

// Append-only Notification audit trail (spec section 24: "audit material actions where useful -
// notification created; marked read; dismissed; bulk marked read. Do not audit every panel-open.
// Avoid duplicating sensitive notification body."). Mirrors
// src/server/operations/task-events.ts's own explicit-metadata-allowlist idiom exactly - deliberately
// NOT src/server/authz/audit.ts's `auditEvents`, whose `AuditOperation` enum is closed to
// Administration's own access-changing operations only (see that file's own comment); this is this
// module's own domain event log, same as every other domain's.

type ValueCheck = (value: unknown) => boolean;

const oneOf =
  (allowed: readonly string[]): ValueCheck =>
  (value) =>
    typeof value === "string" && allowed.includes(value);
const isOpaqueRef: ValueCheck = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const isCount: ValueCheck = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100000;

// Deliberately NEVER allowlists `title`/`bodyPreview` - the audit trail records THAT a notification
// was created/read/dismissed and which source/type it was about, never a second copy of its human
// copy (spec section 24's own "avoid duplicating sensitive notification body").
export const NOTIFICATION_EVENT_METADATA_ALLOWLIST: Readonly<Record<string, ValueCheck>> = {
  type: oneOf(NOTIFICATION_TYPES),
  sourceDomain: oneOf(NOTIFICATION_SOURCE_DOMAINS),
  sourceRef: isOpaqueRef,
  count: isCount,
};

export function redactNotificationEventMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!Object.prototype.hasOwnProperty.call(NOTIFICATION_EVENT_METADATA_ALLOWLIST, key)) continue;
    if (!NOTIFICATION_EVENT_METADATA_ALLOWLIST[key]!(value)) continue;
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

export type NotificationEventInput = { kind: NotificationEventKind; actorUserRef: string; metadata: Record<string, unknown> | null; requestId: string; createdAt: string };

export function buildNotificationEvent(input: NotificationEventInput): NotificationEvent {
  return notificationEventSchema.parse({
    kind: input.kind,
    actorUserRef: input.actorUserRef,
    metadata: redactNotificationEventMetadata(input.metadata),
    requestId: input.requestId,
    createdAt: input.createdAt,
  });
}

export function appendNotificationEvent(tx: FirebaseFirestore.Transaction, notificationRef: string, input: NotificationEventInput): void {
  txCreateNotificationEvent(tx, notificationRef, randomUUID(), buildNotificationEvent(input));
}
