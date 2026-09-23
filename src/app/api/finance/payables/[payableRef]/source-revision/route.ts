import { getPayableSourceRevision } from "@/server/finance-payables";
import { resolveRequestActor, toFinancePayablesHttpResponse } from "@/server/finance-payables/http";

type RouteParams = { params: Promise<{ payableRef: string }> };

// GET /api/finance/payables/[payableRef]/source-revision
// CURRENT | AGREEMENT_REVISION_AVAILABLE | REVIEW_REVISION_AVAILABLE |
// MULTIPLE_SOURCE_REVISIONS_AVAILABLE. A WARNING ONLY: this read never mutates the payable, never
// recalculates money and never re-pins a source version. Adopting a newer source is an explicit,
// reasoned revision (POST .../revise with refreshSource). Requires the finance feature only.
export async function GET(_request: Request, { params }: RouteParams) {
  const { payableRef } = await params;
  const actor = await resolveRequestActor();

  const result = await getPayableSourceRevision(actor, payableRef);
  return toFinancePayablesHttpResponse(result);
}
