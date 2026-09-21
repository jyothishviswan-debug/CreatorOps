import { getAgreementKycStatus } from "@/server/finance-agreements";
import { resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

type RouteParams = { params: Promise<{ agreementRef: string }> };

// GET /api/finance/agreements/[agreementRef]/kyc-status - KYC completeness of the counterparty as a
// STATUS only (component detail needs the identity sensitive category; never a value).
export async function GET(_request: Request, { params }: RouteParams) {
  const { agreementRef } = await params;
  const actor = await resolveRequestActor();

  const result = await getAgreementKycStatus(actor, agreementRef);
  return toFinanceAgreementsHttpResponse(result);
}
