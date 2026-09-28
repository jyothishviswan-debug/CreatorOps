import { getAdminFirestore } from "@/server/firebase/admin";

import { notificationDocSchema, notificationEventSchema, type NotificationDoc, type NotificationEvent } from "./types";

// Collection accessors + parse-on-read/parse-on-write helpers - mirrors
// src/server/operations/firestore.ts's own discipline exactly (see that file's header comment).

export const NOTIFICATIONS_COLLECTIONS = {
  notifications: "notifications",
  notificationEvents: "events", // subcollection under notifications/{notificationRef}
  notificationBulkEvents: "notificationBulkEvents", // top-level: audit rows with no single owning notification (mark-all-read)
} as const;

export function notificationsCollection() {
  return getAdminFirestore().collection(NOTIFICATIONS_COLLECTIONS.notifications);
}
export function notificationEventsCollection(notificationRef: string) {
  return notificationsCollection().doc(notificationRef).collection(NOTIFICATIONS_COLLECTIONS.notificationEvents);
}
export function notificationBulkEventsCollection() {
  return getAdminFirestore().collection(NOTIFICATIONS_COLLECTIONS.notificationBulkEvents);
}

export const MAX_NOTIFICATION_LIST_SCAN = 100;

// --- Reads: safeParse, null on missing or malformed -------------------------------------------------
export async function getNotificationDoc(notificationRef: string): Promise<NotificationDoc | null> {
  const snapshot = await notificationsCollection().doc(notificationRef).get();
  if (!snapshot.exists) return null;
  const result = notificationDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// --- In-transaction reads/writes (Firestore requires every read before any write) -------------------
export async function txGetNotification(tx: FirebaseFirestore.Transaction, notificationRef: string): Promise<NotificationDoc | null> {
  const snapshot = await tx.get(notificationsCollection().doc(notificationRef));
  if (!snapshot.exists) return null;
  const result = notificationDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// Create-only write - the idempotency mechanism itself (see ids.ts's header comment). Never used for
// an update; a second `.create()` at the same deterministic doc id throws ALREADY_EXISTS, which
// notification-service.ts's createNotification explicitly treats as success, not an error.
export function txCreateNotification(tx: FirebaseFirestore.Transaction, doc: NotificationDoc): void {
  tx.create(notificationsCollection().doc(doc.notificationRef), notificationDocSchema.parse(doc));
}

export function txSetNotification(tx: FirebaseFirestore.Transaction, doc: NotificationDoc): void {
  tx.set(notificationsCollection().doc(doc.notificationRef), notificationDocSchema.parse(doc));
}

export function txCreateNotificationEvent(tx: FirebaseFirestore.Transaction, notificationRef: string, eventId: string, event: NotificationEvent): void {
  tx.create(notificationEventsCollection(notificationRef).doc(eventId), notificationEventSchema.parse(event));
}

// One row per bulk mark-all-read call (spec section 24: audited as ONE action, not one event per
// affected notification).
export async function createNotificationBulkEvent(recipientUserRef: string, event: NotificationEvent): Promise<void> {
  await notificationBulkEventsCollection().add({ recipientUserRef, ...notificationEventSchema.parse(event) });
}

// --- Bounded, recipient-scoped lists (spec section 3/9/13/32: NEVER an unscoped query, always a
// single equality-filtered-by-recipient query, always capped, always cursor-paginated) -------------
export type NotificationListPage = { docs: NotificationDoc[]; hasMore: boolean };

async function parsePage(snapshot: FirebaseFirestore.QuerySnapshot, bound: number): Promise<NotificationListPage> {
  const docs: NotificationDoc[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = notificationDocSchema.safeParse(doc.data());
    if (parsed.success) docs.push(parsed.data);
  }
  return { docs, hasMore: snapshot.docs.length > bound };
}

export async function listNotificationsByRecipient(recipientUserRef: string, status: "unread" | "all" | "dismissed", limit: number, cursor: { createdAt: string; notificationRef: string } | null): Promise<NotificationListPage> {
  const bound = Math.max(1, Math.min(limit, MAX_NOTIFICATION_LIST_SCAN));
  let query: FirebaseFirestore.Query = notificationsCollection().where("recipientUserRef", "==", recipientUserRef);
  if (status === "unread") query = query.where("unread", "==", true);
  else if (status === "dismissed") query = query.where("dismissed", "==", true);
  query = query.orderBy("createdAt", "desc");
  if (cursor) {
    const docSnap = await notificationsCollection().doc(cursor.notificationRef).get();
    query = docSnap.exists ? query.startAfter(docSnap) : query.startAfter(cursor.createdAt);
  }
  const snapshot = await query.limit(bound + 1).get();
  return parsePage(snapshot, bound);
}

// Trusted, server/aggregation-backed unread count (spec section 9: "do not count by downloading all
// notification docs"). A single equality-only multi-field query (no orderBy/range) - Firestore
// serves this from the per-field single-field indexes via a zig-zag merge, no composite index
// required.
export async function countUnreadNotifications(recipientUserRef: string): Promise<number> {
  const query = notificationsCollection().where("recipientUserRef", "==", recipientUserRef).where("unread", "==", true);
  const snapshot = await query.count().get();
  return snapshot.data().count;
}
