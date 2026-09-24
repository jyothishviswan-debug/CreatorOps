import { NextResponse } from "next/server";

import { createTask, listTasks } from "@/server/operations";
import { newRequestId, optionalIntegerParam, optionalStringParam, parseJsonBody, resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

// GET /api/operations/tasks?status=&assigneeUserRef=&targetType=&targetRef=&priority=&limit=
// The Tasks list: bounded, scoped to the actor's own assignee/creator/region/team grants unless a
// global scope grant is held. Requires the `operations` feature.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);

  const result = await listTasks(actor, {
    status: optionalStringParam(searchParams, "status"),
    assigneeUserRef: optionalStringParam(searchParams, "assigneeUserRef"),
    targetType: optionalStringParam(searchParams, "targetType"),
    targetRef: optionalStringParam(searchParams, "targetRef"),
    priority: optionalStringParam(searchParams, "priority"),
    limit: optionalIntegerParam(searchParams, "limit"),
  });
  return toOperationsHttpResponse(result);
}

// POST /api/operations/tasks {title, target, assigneeUserRef, notes?, priority?, dueAt?, regionIds?, teamIds?}
// Creates a new Task (head + immutable version 1); needs manage_tasks. The assignee must be
// admitted/active.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createTask(actor, body, newRequestId());
  if (!result.ok) return toOperationsHttpResponse(result);
  return NextResponse.json(result.data, { status: 201 });
}
