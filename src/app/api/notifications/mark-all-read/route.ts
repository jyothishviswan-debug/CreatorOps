import { markAllNotificationsRead } from "@/server/notifications";
import { newRequestId, resolveRequestActor, toNotificationsHttpResponse } from "@/server/notifications/http";

// POST /api/notifications/mark-all-read - marks the caller's own bounded page of unread
// notifications as read (spec section 8). Never touches another recipient's notifications.
export async function POST() {
  const actor = await resolveRequestActor();
  const result = await markAllNotificationsRead(actor, newRequestId());
  return toNotificationsHttpResponse(result);
}
