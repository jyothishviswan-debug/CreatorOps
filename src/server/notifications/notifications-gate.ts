import type { ActorContext } from "@/server/authz/types";

import { getNotificationDoc } from "./firestore";
import { notificationsNotFoundResult, notificationsUnauthorizedResult, type NotificationDoc, type NotificationsErrorResult } from "./types";

// Notifications Completion - the gate (see the stage's own operational addendum / continuity doc for
// the full reasoning). Deliberately NOT the standard FeatureAccess/ActionPermission/RecordScope chain
// every other domain in this codebase uses (compare src/server/operations/operations-gate.ts): a
// user's own notification inbox is an inherently PERSONAL resource, not a feature-gated one - every
// admitted/active actor must always be able to see their OWN notifications regardless of which
// feature grants they hold (spec section 14: "visible for admitted/active user", not "visible to
// users with the notifications feature"). Forcing the general scope-resolution machinery onto this
// would invite exactly the mistake section 3 warns against - a GLOBAL-scope admin override that lets
// one user list/read ANOTHER user's notifications. There is no such override here, on purpose.
//
// Admission itself is already proven the moment `actor` is non-null: resolveActor() (see
// src/server/authz/actor.ts) only ever returns a non-null ActorContext for a user whose own
// users/{uid} document exists, matches, and is active. So the ENTIRE admission check is `actor !==
// null` - and then every single query/mutation below applies one hard, non-negotiable rule:
// `recipientUserRef === actor.userRef`, checked again independently at read/write time, never
// inferred, never relaxed, never bypassed by a scope grant of any kind.
export type NotificationsAccessResult = { ok: true; actor: ActorContext } | { ok: false; error: NotificationsErrorResult };

export function requireNotificationsAccess(actor: ActorContext | null): NotificationsAccessResult {
  if (!actor) return { ok: false, error: notificationsUnauthorizedResult("not_authenticated") };
  return { ok: true, actor };
}

// Loads a notification and independently re-proves recipient ownership before handing it back -
// section 3's hard requirement ("a user must never be able to ... guess another user's notification
// ref ... read/dismiss another user's notification"). A wrong-owner or missing ref both return the
// SAME neutral not-found (never a distinct "forbidden" for an existing-but-not-yours ref - that
// would itself leak "this ref exists" to a guesser, exactly the enumeration spec section 31 tests).
export type AuthorizedNotification = { doc: NotificationDoc };
export type LoadAuthorizedNotificationResult = { ok: true; authorized: AuthorizedNotification } | { ok: false; error: NotificationsErrorResult };

export async function loadOwnNotification(actor: ActorContext | null, rawNotificationRef: unknown): Promise<LoadAuthorizedNotificationResult> {
  const access = requireNotificationsAccess(actor);
  if (!access.ok) return { ok: false, error: access.error };

  if (typeof rawNotificationRef !== "string" || rawNotificationRef.length === 0 || rawNotificationRef.length > 80) {
    return { ok: false, error: notificationsNotFoundResult() };
  }
  const doc = await getNotificationDoc(rawNotificationRef);
  if (!doc || doc.recipientUserRef !== access.actor.userRef) return { ok: false, error: notificationsNotFoundResult() };
  return { ok: true, authorized: { doc } };
}
