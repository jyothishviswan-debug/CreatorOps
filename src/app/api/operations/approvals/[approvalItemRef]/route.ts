import { getApprovalItem } from "@/server/operations";
import { resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

type RouteParams = { params: Promise<{ approvalItemRef: string }> };

// GET /api/operations/approvals/[approvalItemRef]
// The safe projection of one pending item, re-derived live from its source module.
export async function GET(_request: Request, { params }: RouteParams) {
  const { approvalItemRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getApprovalItem(actor, approvalItemRef);
  return toOperationsHttpResponse(result);
}
