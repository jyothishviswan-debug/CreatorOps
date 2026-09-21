import { listAgreementVersions } from "@/server/finance-agreements";
import { resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

type RouteParams = { params: Promise<{ agreementRef: string }> };

// GET /api/finance/agreements/[agreementRef]/versions - bounded version summaries (no terms).
export async function GET(_request: Request, { params }: RouteParams) {
  const { agreementRef } = await params;
  const actor = await resolveRequestActor();

  const result = await listAgreementVersions(actor, agreementRef);
  return toFinanceAgreementsHttpResponse(result);
}
