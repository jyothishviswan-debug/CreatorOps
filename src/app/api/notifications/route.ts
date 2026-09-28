import { listMyNotifications } from "@/server/notifications";
import { resolveRequestActor, toNotificationsHttpResponse } from "@/server/notifications/http";

// GET /api/notifications?status=unread|all|dismissed&limit=&cursor=
// Recipient-scoped only (spec section 3/9) - there is no query parameter or admin override that can
// list another user's notifications; the recipient is always the calling actor, resolved server-side.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const limitParam = searchParams.get("limit");
  const cursor = searchParams.get("cursor");

  const result = await listMyNotifications(actor, {
    status: status ?? undefined,
    limit: limitParam ? Number(limitParam) : undefined,
    cursor: cursor ?? undefined,
  });
  return toNotificationsHttpResponse(result);
}
