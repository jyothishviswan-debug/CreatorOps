import { getExtractionResult } from "@/server/finance-agreements";
import { optionalStringParam, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

type RouteParams = { params: Promise<{ agreementRef: string }> };

// GET /api/finance/agreements/[agreementRef]/extraction?runRef= - one extraction run (default: the
// latest), shaped for THIS actor: ordinary proposals for everyone authorized, raw snippets only with
// finance_contracts, identity values only with the counterparty's identity category as well.
export async function GET(request: Request, { params }: RouteParams) {
  const { agreementRef } = await params;
  const actor = await resolveRequestActor();

  const result = await getExtractionResult(actor, { agreementRef, extractionRunRef: optionalStringParam(new URL(request.url).searchParams, "runRef") });
  return toFinanceAgreementsHttpResponse(result);
}
