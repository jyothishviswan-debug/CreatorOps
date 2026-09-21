import { NextResponse } from "next/server";

import { extractContract } from "@/server/finance-agreements";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

// POST /api/finance/contracts/extract {agreementRef, version, artifactRef} - parse one uploaded
// contract PDF (local, deterministic) into a recorded extraction run. A preparation step only:
// nothing extracted is attached, confirmed or operational, and no Partner / Vendor / KYC record is
// written. An unreadable / scanned PDF is a MANUAL_REVIEW_REQUIRED result, not an error.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await extractContract(actor, body, newRequestId());
  return toFinanceAgreementsHttpResponse(result);
}
