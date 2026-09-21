import { getAgreementDetail } from "@/server/finance-agreements";
import { optionalIntegerParam, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

type RouteParams = { params: Promise<{ agreementRef: string }> };

// GET /api/finance/agreements/[agreementRef]?version= - the head, bounded version summaries and one
// version's detail (default: the open version, else the governing one). Live Record Scope on every read.
export async function GET(request: Request, { params }: RouteParams) {
  const { agreementRef } = await params;
  const actor = await resolveRequestActor();
  const version = optionalIntegerParam(new URL(request.url).searchParams, "version");

  const result = await getAgreementDetail(actor, agreementRef, version === undefined ? {} : { version });
  return toFinanceAgreementsHttpResponse(result);
}
