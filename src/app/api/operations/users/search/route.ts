import { searchActiveOperationsUsers } from "@/server/operations";
import { optionalIntegerParam, optionalStringParam, resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

// GET /api/operations/users/search?emailPrefix=&limit= - a bounded, active-user-only search for the
// assignee/owner picker (Create Task, Create Reminder). Gated on the base `operations` feature only
// (never Administration's own manage_users action - see user-search.ts's own comment for why).
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);
  const result = await searchActiveOperationsUsers(actor, { emailPrefix: optionalStringParam(searchParams, "emailPrefix"), limit: optionalIntegerParam(searchParams, "limit") });
  return toOperationsHttpResponse(result);
}
