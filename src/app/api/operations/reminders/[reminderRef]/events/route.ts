import { listReminderEvents } from "@/server/operations";
import { optionalIntegerParam, resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

type RouteParams = { params: Promise<{ reminderRef: string }> };

// GET /api/operations/reminders/[reminderRef]/events?limit=
export async function GET(request: Request, { params }: RouteParams) {
  const { reminderRef } = await params;
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);
  const result = await listReminderEvents(actor, reminderRef, optionalIntegerParam(searchParams, "limit"));
  return toOperationsHttpResponse(result);
}
