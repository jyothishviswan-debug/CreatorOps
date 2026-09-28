import { createHash } from "node:crypto";

import type { NotificationSourceDomain, NotificationType } from "./types";

// Deterministic dedupe/idempotency (spec section 7). Mirrors
// src/server/reports/ids.ts's generateArtifactRef exactly: a notificationRef is the sha256 of its
// own dedupeKey, never random, so a retried/replayed/concurrently-emitted call for the SAME event +
// recipient always re-derives the SAME doc id. The caller (notification-service.ts's createNotification)
// writes with `.create()` and treats "already exists" as success - Firestore's create-only write IS
// the idempotency mechanism, not application-level locking.
//
// `distinguisher` is what makes a genuinely NEW occurrence of a recurring event type (e.g. a second,
// real Meeting revision) mint a distinct notification instead of colliding with the first: callers
// pass a stable value (often omitted / a constant) for a one-shot event, and a monotonically
// changing value (a docVersion, a version number) for a recurring one. See projection.ts for what
// each event type passes.
export function buildDedupeKey(input: { sourceDomain: NotificationSourceDomain; type: NotificationType; sourceRef: string; recipientUserRef: string; distinguisher?: string }): string {
  const distinguisher = input.distinguisher ?? "1";
  return `${input.sourceDomain}|${input.sourceRef}|${input.type}|${input.recipientUserRef}|${distinguisher}`;
}

export function generateNotificationRef(dedupeKey: string): string {
  const hash = createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32);
  return `ntf_${hash}`;
}
