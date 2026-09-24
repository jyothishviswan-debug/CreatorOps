import { getReminder } from "@/server/operations";
import { resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

type RouteParams = { params: Promise<{ reminderRef: string }> };

// GET /api/operations/reminders/[reminderRef]
export async function GET(_request: Request, { params }: RouteParams) {
  const { reminderRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getReminder(actor, reminderRef);
  return toOperationsHttpResponse(result);
}
