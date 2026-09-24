import { NextResponse } from "next/server";

import { createReminder, listReminders } from "@/server/operations";
import { newRequestId, optionalBooleanParam, optionalIntegerParam, optionalStringParam, parseJsonBody, resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

// GET /api/operations/reminders?status=&recipientUserRef=&taskRef=&dueOnly=&limit=
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);

  const result = await listReminders(actor, {
    status: optionalStringParam(searchParams, "status"),
    recipientUserRef: optionalStringParam(searchParams, "recipientUserRef"),
    taskRef: optionalStringParam(searchParams, "taskRef"),
    dueOnly: optionalBooleanParam(searchParams, "dueOnly"),
    limit: optionalIntegerParam(searchParams, "limit"),
  });
  return toOperationsHttpResponse(result);
}

// POST /api/operations/reminders {target, recipientUserRef, message, reminderAt, taskRef?, approvalItemRef?, regionIds?, teamIds?}
// Creates a new Reminder; needs manage_reminders. Idempotent only when origin+sourceKey are
// supplied (system generation) - a manual Reminder is never deduplicated.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createReminder(actor, body, newRequestId());
  if (!result.ok) return toOperationsHttpResponse(result);
  return NextResponse.json(result.data.reminder, { status: 201 });
}
