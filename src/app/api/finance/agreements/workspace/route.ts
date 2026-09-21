import { listAgreementsWorkspace } from "@/server/finance-agreements";
import { optionalStringParam, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

// GET /api/finance/agreements/workspace?lifecycle=&counterpartyType=&q=&platform=&period=&discrepancy=&cursor=&limit=
// The Agreement workspace list: scope-first, bounded, deterministic (last updated desc, then agreementRef), paged with an
// opaque cursor (limit 1-20, default 20). Filters are read-only narrowing; an unknown filter value is ignored with a
// notice. `totalInBoundedSet` is exact only while `disclosure.headsTruncated` is false. Requires the finance feature.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);

  const result = await listAgreementsWorkspace(actor, {
    lifecycle: optionalStringParam(searchParams, "lifecycle"),
    counterpartyType: optionalStringParam(searchParams, "counterpartyType"),
    q: optionalStringParam(searchParams, "q"),
    platform: optionalStringParam(searchParams, "platform"),
    period: optionalStringParam(searchParams, "period"),
    discrepancy: optionalStringParam(searchParams, "discrepancy"),
    cursor: optionalStringParam(searchParams, "cursor"),
    limit: optionalStringParam(searchParams, "limit"),
  });
  return toFinanceAgreementsHttpResponse(result);
}
