import { NextResponse } from "next/server";

import { updateCounterpartyContactFromAgreement } from "@/server/finance-agreements";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

type RouteParams = { params: Promise<{ agreementRef: string }> };

// POST /api/finance/agreements/[agreementRef]/master-data - copy a decided email/phone onto the Partner/Vendor through the owning module {version, fieldKey, mode, resolution?, expectedCounterpartyVersion}
// The URL's agreementRef always wins over anything in the body.
export async function POST(request: Request, { params }: RouteParams) {
  const { agreementRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await updateCounterpartyContactFromAgreement(actor, { ...(body as object), agreementRef }, newRequestId());
  return toFinanceAgreementsHttpResponse(result);
}
