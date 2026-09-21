import { NextResponse } from "next/server";

import { confirmAgreementVersion } from "@/server/finance-agreements";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

type RouteParams = { params: Promise<{ agreementRef: string }> };

// POST /api/finance/agreements/[agreementRef]/confirm - freeze the open version {version, expectedDocVersion}; 409 with blockers when not ready
// The URL's agreementRef always wins over anything in the body.
export async function POST(request: Request, { params }: RouteParams) {
  const { agreementRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await confirmAgreementVersion(actor, { ...(body as object), agreementRef }, newRequestId());
  return toFinanceAgreementsHttpResponse(result);
}
