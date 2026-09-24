import { listApprovalQueue } from "@/server/operations";
import { optionalIntegerParam, optionalStringParam, resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

// GET /api/operations/approvals?sourceModule=&limit=
// Section 6: a live, read-only projection of pending decisions across four authoritative modules
// (Partner Reviews, Finance Payables, Finance Invoices, Finance Payments). No routed action exists
// in Step 18A - see approval-queue-service.ts's own top comment.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);
  const result = await listApprovalQueue(actor, { sourceModule: optionalStringParam(searchParams, "sourceModule"), limit: optionalIntegerParam(searchParams, "limit") });
  return toOperationsHttpResponse(result);
}
