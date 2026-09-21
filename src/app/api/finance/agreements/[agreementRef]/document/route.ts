import { NextResponse } from "next/server";

import { getAgreementDocumentStatus, storeAgreementDocument } from "@/server/finance-agreements";
import { newRequestId, optionalIntegerParam, parseJsonBody, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

type RouteParams = { params: Promise<{ agreementRef: string }> };

// GET /api/finance/agreements/[agreementRef]/document?version= - the durable-document status of one version (default: the open / governing one).
// The Drive link is present only for an actor holding finance_contracts.
export async function GET(request: Request, { params }: RouteParams) {
  const { agreementRef } = await params;
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);

  const result = await getAgreementDocumentStatus(actor, { agreementRef, version: optionalIntegerParam(searchParams, "version") });
  return toFinanceAgreementsHttpResponse(result);
}

// POST /api/finance/agreements/[agreementRef]/document - store (or retry) the ORIGINAL signed document of a confirmed version in Drive {version, expectedDocVersion?}; needs manage_agreements
// Idempotent. A Drive failure is a 200 with outcome "failed" (retriable), never a fabricated link. The URL's agreementRef always wins over anything in the body.
export async function POST(request: Request, { params }: RouteParams) {
  const { agreementRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await storeAgreementDocument(actor, { ...(body as object), agreementRef }, newRequestId());
  return toFinanceAgreementsHttpResponse(result);
}
