import { getMyUnreadCount } from "@/server/notifications";
import { resolveRequestActor, toNotificationsHttpResponse } from "@/server/notifications/http";

// GET /api/notifications/unread-count - a trusted, recipient-scoped, aggregation-query-backed count
// (spec section 9). Never derived by downloading notification docs client-side.
export async function GET() {
  const actor = await resolveRequestActor();
  const result = await getMyUnreadCount(actor);
  return toNotificationsHttpResponse(result);
}
