import { dismissNotification } from "@/server/notifications";
import { newRequestId, resolveRequestActor, toNotificationsHttpResponse } from "@/server/notifications/http";

type RouteParams = { params: Promise<{ notificationRef: string }> };

// POST /api/notifications/[notificationRef]/dismiss - hides it from the normal attention list
// without deleting the underlying notification/event history (spec section 8).
export async function POST(_request: Request, { params }: RouteParams) {
  const { notificationRef } = await params;
  const actor = await resolveRequestActor();
  const result = await dismissNotification(actor, notificationRef, newRequestId());
  return toNotificationsHttpResponse(result);
}
