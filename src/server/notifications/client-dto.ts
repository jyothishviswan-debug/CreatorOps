import type { NotificationDoc } from "./types";

// The ONLY shape of a notification ever handed to the browser (spec section 11/12/31): no raw
// Firestore doc internals beyond the already-opaque notificationRef, no sourceEventKey (an
// operator-facing identity string, not recipient copy), no dedupeKey, no createdByUserRef (a
// userRef, still never shown as notification copy). `unread`/`dismissed` are re-derived here from
// readAt/dismissedAt rather than trusting the stored denormalized flags blindly, so a DTO consumer
// never depends on that internal query-optimization detail being correct.
export type NotificationDto = {
  notificationRef: string;
  type: NotificationDoc["type"];
  sourceDomain: NotificationDoc["sourceDomain"];
  title: string;
  bodyPreview: string;
  deepLink: string;
  severity: NotificationDoc["severity"];
  createdAt: string;
  readAt: string | null;
  dismissedAt: string | null;
  staleAt: string | null;
  unread: boolean;
};

export function toNotificationDto(doc: NotificationDoc): NotificationDto {
  return {
    notificationRef: doc.notificationRef,
    type: doc.type,
    sourceDomain: doc.sourceDomain,
    title: doc.title,
    bodyPreview: doc.bodyPreview,
    deepLink: doc.deepLink,
    severity: doc.severity,
    createdAt: doc.createdAt,
    readAt: doc.readAt,
    dismissedAt: doc.dismissedAt,
    staleAt: doc.staleAt,
    unread: doc.readAt === null && doc.dismissedAt === null,
  };
}
