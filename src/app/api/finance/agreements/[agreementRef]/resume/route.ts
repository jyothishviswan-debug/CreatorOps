import { NextResponse } from "next/server";

import { resumeAgreement } from "@/server/finance-agreements";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

type RouteParams = { params: Promise<{ agreementRef: string }> };

// POST /api/finance/agreements/[agreementRef]/resume - SUSPENDED -> ACTIVE {expectedDocVersion (the HEAD's)}; needs activate_agreements
// The URL's agreementRef always wins over anything in the body.
export async function POST(request: Request, { params }: RouteParams) {
  const { agreementRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await resumeAgreement(actor, { ...(body as object), agreementRef }, newRequestId());
  return toFinanceAgreementsHttpResponse(result);
}
