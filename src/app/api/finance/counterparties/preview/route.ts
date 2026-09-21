import { getCounterpartyPreview } from "@/server/finance-agreements";
import { optionalStringParam, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

// GET /api/finance/counterparties/preview?counterpartyType=PARTNER|VENDOR&ref= - the CreatorOps master-data preview of ONE
// authorized counterparty: ordinary facts + KYC STATUS only, never an identity value (see counterparty-picker-service).
// `type` is accepted as an alias of `counterpartyType`.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);

  const result = await getCounterpartyPreview(actor, {
    type: optionalStringParam(searchParams, "counterpartyType") ?? optionalStringParam(searchParams, "type"),
    ref: optionalStringParam(searchParams, "ref"),
  });
  return toFinanceAgreementsHttpResponse(result);
}
