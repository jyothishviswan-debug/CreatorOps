import { NextResponse } from "next/server";

import { setAgreementParties } from "@/server/finance-agreements";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

type RouteParams = { params: Promise<{ agreementRef: string }> };

// FINAL_EXECUTION #10: POST /api/finance/agreements/[agreementRef]/parties - replaces the OPEN, unconfirmed
// version's whole `parties` array {version, expectedDocVersion, parties}. The URL's agreementRef always wins.
export async function POST(request: Request, { params }: RouteParams) {
  const { agreementRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await setAgreementParties(actor, { ...(body as object), agreementRef }, newRequestId());
  return toFinanceAgreementsHttpResponse(result);
}
