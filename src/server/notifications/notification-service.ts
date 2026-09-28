import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { toNotificationDto, type NotificationDto } from "./client-dto";
import { countUnreadNotifications, createNotificationBulkEvent, listNotificationsByRecipient, notificationsCollection, txCreateNotification, txGetNotification, txSetNotification } from "./firestore";
import { buildDedupeKey, generateNotificationRef } from "./ids";
import { appendNotificationEvent, buildNotificationEvent } from "./notification-events";
import { loadOwnNotification, requireNotificationsAccess } from "./notifications-gate";
import {
  listNotificationsQuerySchema,
  notificationDocSchema,
  notificationsInvalidInputResult,
  notificationsNotFoundResult,
  type ListNotificationsQuery,
  type NotificationDoc,
  type NotificationSeverity,
  type NotificationSourceDomain,
  type NotificationType,
  type NotificationsServiceResult,
} from "./types";

// --- Trusted projection entry point (spec section 17) -------------------------------------------
// The ONE place a Notification document is ever written. Every event-catalog hook in projection.ts
// calls THIS, never a raw Firestore write of its own - recipient validation, dedupe, safe copy,
// source metadata and the deep link are all already decided by the caller (who owns that context);
// this function's own job is purely the idempotent, transactional persistence + audit trail.
//
// Deliberately NOT actor-gated the way an HTTP-facing service function is: the caller is always
// already-authorized server code reacting to an already-committed, already-authorized source
// mutation (see every projection.ts function's own header comment) - there is no independent
// "actor may create a notification" permission to check here, only "does this recipient look like a
// real, resolvable user", which every caller has already proven via requireAdmittedActiveUser (or
// equivalent) before calling this.
export type CreateNotificationInput = {
  recipientUserRef: string;
  type: NotificationType;
  sourceDomain: NotificationSourceDomain;
  sourceRef: string;
  distinguisher?: string;
  title: string;
  bodyPreview: string;
  deepLink: string;
  severity?: NotificationSeverity;
  createdByUserRef: string | null;
  requestId: string;
};

export type CreateNotificationOutcome = { outcome: "created" | "existing"; notificationRef: string };

export async function createNotification(input: CreateNotificationInput): Promise<CreateNotificationOutcome> {
  // Fail closed rather than guess (spec section 6) - never write a notification for an empty/missing
  // recipient. A caller bug that got this far is swallowed here, not surfaced as a broken source
  // mutation (spec section 18).
  if (!input.recipientUserRef) return { outcome: "existing", notificationRef: "" };

  const dedupeKey = buildDedupeKey({ sourceDomain: input.sourceDomain, type: input.type, sourceRef: input.sourceRef, recipientUserRef: input.recipientUserRef, distinguisher: input.distinguisher });
  const notificationRef = generateNotificationRef(dedupeKey);
  const now = new Date().toISOString();

  // Same race-safe "read inside the transaction, conditionally write" idempotency idiom as
  // src/server/operations/reminder-service.ts's createReminder / task-service.ts's
  // generateSystemTask (see those files' own header comments): Firestore's automatic
  // transaction-conflict-and-retry is what actually makes concurrent emission safe, not any
  // application-level lock. This directly satisfies spec section 7 (retries, concurrent emission,
  // replay all converge on exactly one doc) and section 28 (recipient isolation across concurrent
  // create attempts for different recipients of the same source event never cross-write).
  const outcome = await getAdminFirestore().runTransaction<"created" | "existing">(async (tx) => {
    const existing = await txGetNotification(tx, notificationRef);
    if (existing) return "existing";

    const doc: NotificationDoc = notificationDocSchema.parse({
      notificationRef,
      recipientUserRef: input.recipientUserRef,
      type: input.type,
      sourceDomain: input.sourceDomain,
      sourceRef: input.sourceRef,
      sourceEventKey: input.distinguisher ? `${input.type}:${input.distinguisher}` : input.type,
      title: input.title,
      bodyPreview: input.bodyPreview,
      deepLink: input.deepLink,
      severity: input.severity ?? "NORMAL",
      dedupeKey,
      createdAt: now,
      createdByUserRef: input.createdByUserRef,
      readAt: null,
      dismissedAt: null,
      staleAt: null,
      expiresAt: null,
      unread: true,
      dismissed: false,
    });
    txCreateNotification(tx, doc);
    appendNotificationEvent(tx, notificationRef, {
      kind: "NOTIFICATION_CREATED",
      actorUserRef: input.createdByUserRef ?? "system",
      metadata: { type: input.type, sourceDomain: input.sourceDomain, sourceRef: input.sourceRef },
      requestId: input.requestId,
      createdAt: now,
    });
    return "created";
  });

  return { outcome, notificationRef };
}

// --- Recipient-scoped list (spec section 9/13/15) -------------------------------------------------
export type NotificationListResult = { notifications: NotificationDto[]; nextCursor: string | null };

function encodeCursor(doc: NotificationDoc): string {
  return Buffer.from(`${doc.createdAt}|${doc.notificationRef}`, "utf8").toString("base64url");
}
function decodeCursor(cursor: string): { createdAt: string; notificationRef: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = raw.indexOf("|");
    if (separator === -1) return null;
    const createdAt = raw.slice(0, separator);
    const notificationRef = raw.slice(separator + 1);
    if (!createdAt || !notificationRef) return null;
    return { createdAt, notificationRef };
  } catch {
    return null;
  }
}

export async function listMyNotifications(actor: ActorContext | null, rawQuery: unknown): Promise<NotificationsServiceResult<NotificationListResult>> {
  const access = requireNotificationsAccess(actor);
  if (!access.ok) return access.error;

  const parsed = listNotificationsQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) return notificationsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const query: ListNotificationsQuery = parsed.data;
  const limit = query.limit ?? 20;
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return notificationsInvalidInputResult("Invalid cursor.");

  const page = await listNotificationsByRecipient(access.actor.userRef, query.status, limit, cursor);
  const last = page.docs[page.docs.length - 1];
  return { ok: true, data: { notifications: page.docs.map(toNotificationDto), nextCursor: page.hasMore && last ? encodeCursor(last) : null } };
}

// --- Trusted unread count (spec section 9) ---------------------------------------------------------
export async function getMyUnreadCount(actor: ActorContext | null): Promise<NotificationsServiceResult<{ count: number }>> {
  const access = requireNotificationsAccess(actor);
  if (!access.ok) return access.error;
  const count = await countUnreadNotifications(access.actor.userRef);
  return { ok: true, data: { count } };
}

// --- Mutations (spec section 8/24) -----------------------------------------------------------------
export async function markNotificationRead(actor: ActorContext | null, rawNotificationRef: unknown, requestId: string): Promise<NotificationsServiceResult<NotificationDto>> {
  const loaded = await loadOwnNotification(actor, rawNotificationRef);
  if (!loaded.ok) return loaded.error;
  const recipientUserRef = loaded.authorized.doc.recipientUserRef;

  type Outcome = { kind: "ok"; doc: NotificationDoc } | { kind: "not_found" };
  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const current = await txGetNotification(tx, loaded.authorized.doc.notificationRef);
    if (!current || current.recipientUserRef !== recipientUserRef) return { kind: "not_found" };
    if (current.readAt) return { kind: "ok", doc: current }; // idempotent no-op
    const now = new Date().toISOString();
    const next: NotificationDoc = { ...current, readAt: now, unread: false };
    txSetNotification(tx, next);
    appendNotificationEvent(tx, next.notificationRef, { kind: "NOTIFICATION_READ", actorUserRef: recipientUserRef, metadata: { type: next.type, sourceDomain: next.sourceDomain, sourceRef: next.sourceRef }, requestId, createdAt: now });
    return { kind: "ok", doc: next };
  });

  if (result.kind === "not_found") return notificationsNotFoundResult();
  return { ok: true, data: toNotificationDto(result.doc) };
}

export async function dismissNotification(actor: ActorContext | null, rawNotificationRef: unknown, requestId: string): Promise<NotificationsServiceResult<NotificationDto>> {
  const loaded = await loadOwnNotification(actor, rawNotificationRef);
  if (!loaded.ok) return loaded.error;
  const recipientUserRef = loaded.authorized.doc.recipientUserRef;

  type Outcome = { kind: "ok"; doc: NotificationDoc } | { kind: "not_found" };
  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const current = await txGetNotification(tx, loaded.authorized.doc.notificationRef);
    if (!current || current.recipientUserRef !== recipientUserRef) return { kind: "not_found" };
    if (current.dismissedAt) return { kind: "ok", doc: current }; // idempotent no-op
    const now = new Date().toISOString();
    // Dismissing also implicitly marks it read (spec section 8: dismiss hides from the normal
    // attention list; there is no meaningful "unread and dismissed" state to preserve).
    const next: NotificationDoc = { ...current, dismissedAt: now, readAt: current.readAt ?? now, dismissed: true, unread: false };
    txSetNotification(tx, next);
    appendNotificationEvent(tx, next.notificationRef, { kind: "NOTIFICATION_DISMISSED", actorUserRef: recipientUserRef, metadata: { type: next.type, sourceDomain: next.sourceDomain, sourceRef: next.sourceRef }, requestId, createdAt: now });
    return { kind: "ok", doc: next };
  });

  if (result.kind === "not_found") return notificationsNotFoundResult();
  return { ok: true, data: toNotificationDto(result.doc) };
}

// Bounded mark-all-read (spec section 8/32): only ever operates on the CALLER's own bounded unread
// page (never an unbounded scan) - a recipient with more unread than one page calls this repeatedly
// (the client's own "mark all read" loop) rather than the server ever doing an unbounded write.
const MARK_ALL_READ_BATCH_LIMIT = 200;

export async function markAllNotificationsRead(actor: ActorContext | null, requestId: string): Promise<NotificationsServiceResult<{ updated: number; hasMore: boolean }>> {
  const access = requireNotificationsAccess(actor);
  if (!access.ok) return access.error;

  const page = await listNotificationsByRecipient(access.actor.userRef, "unread", MARK_ALL_READ_BATCH_LIMIT, null);
  if (page.docs.length === 0) return { ok: true, data: { updated: 0, hasMore: false } };

  const now = new Date().toISOString();
  const db = getAdminFirestore();
  const batch = db.batch();
  for (const doc of page.docs) {
    batch.update(notificationsCollection().doc(doc.notificationRef), { readAt: now, unread: false });
  }
  await batch.commit();

  // One summary audit event for the bulk operation (spec section 24: "bulk marked read" is
  // audited as ONE action, not one event per notification) - a best-effort side record, never
  // allowed to undo the read-state write above that already committed.
  await createNotificationBulkEvent(access.actor.userRef, buildNotificationEvent({ kind: "NOTIFICATION_MARK_ALL_READ", actorUserRef: access.actor.userRef, metadata: { count: page.docs.length }, requestId, createdAt: now })).catch(() => undefined);

  return { ok: true, data: { updated: page.docs.length, hasMore: page.hasMore } };
}
