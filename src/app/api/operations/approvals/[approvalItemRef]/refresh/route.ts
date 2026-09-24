import { refreshApprovalItem } from "@/server/operations";
import { resolveRequestActor, toOperationsHttpResponse } from "@/server/operations/http";

type RouteParams = { params: Promise<{ approvalItemRef: string }> };

// POST /api/operations/approvals/[approvalItemRef]/refresh
// Re-derives the item's projection from the CURRENT source state (section 6/13). There is no
// cached copy to invalidate - a "refresh" and a plain GET both run the identical live query; this
// route exists as its own explicit action only to match the spec's own API surface (section 11) and
// to make an intentional client-side re-check legible in the request log, never because the GET
// result is any less current.
export async function POST(_request: Request, { params }: RouteParams) {
  const { approvalItemRef } = await params;
  const actor = await resolveRequestActor();
  const result = await refreshApprovalItem(actor, approvalItemRef);
  return toOperationsHttpResponse(result);
}
