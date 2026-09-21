import { listCounterpartyAgreementDocuments } from "@/server/finance-agreements";
import { optionalStringParam, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

// GET /api/finance/counterparties/documents?counterpartyType=PARTNER|VENDOR&ref= - the signed Agreement documents of ONE authorized
// Partner / Vendor (the same stored Drive reference the Finance detail shows). Needs the finance feature + the counterparty's live scope;
// a document's link is present only for an actor holding finance_contracts. `type` is accepted as an alias of `counterpartyType`.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);

  const result = await listCounterpartyAgreementDocuments(actor, {
    counterpartyType: optionalStringParam(searchParams, "counterpartyType") ?? optionalStringParam(searchParams, "type"),
    ref: optionalStringParam(searchParams, "ref"),
  });
  return toFinanceAgreementsHttpResponse(result);
}
