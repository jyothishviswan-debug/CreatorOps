import { markNotificationRead } from "@/server/notifications";
import { newRequestId, resolveRequestActor, toNotificationsHttpResponse } from "@/server/notifications/http";

type RouteParams = { params: Promise<{ notificationRef: string }> };

// POST /api/notifications/[notificationRef]/read
// A guessed ref, another recipient's ref, or a missing ref all return the SAME neutral 404 (see
// notifications-gate.ts's loadOwnNotification) - never a distinct "forbidden" that would confirm
// the ref's existence to a guesser.
export async function POST(_request: Request, { params }: RouteParams) {
  const { notificationRef } = await params;
  const actor = await resolveRequestActor();
  const result = await markNotificationRead(actor, notificationRef, newRequestId());
  return toNotificationsHttpResponse(result);
}
