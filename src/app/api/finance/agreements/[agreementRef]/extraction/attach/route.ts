import { NextResponse } from "next/server";

import { attachExtractionProposals } from "@/server/finance-agreements";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

type RouteParams = { params: Promise<{ agreementRef: string }> };

// POST /api/finance/agreements/[agreementRef]/extraction/attach - copy an extraction run's non-restricted proposals into the open draft as PENDING {version, expectedDocVersion, extractionRunRef}
// The URL's agreementRef always wins over anything in the body.
export async function POST(request: Request, { params }: RouteParams) {
  const { agreementRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await attachExtractionProposals(actor, { ...(body as object), agreementRef }, newRequestId());
  return toFinanceAgreementsHttpResponse(result);
}
