import { NextResponse } from "next/server";

import { markPayableReadyForInvoice } from "@/server/finance-payables";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinancePayablesHttpResponse } from "@/server/finance-payables/http";

type RouteParams = { params: Promise<{ payableRef: string }> };

// POST /api/finance/payables/[payableRef]/ready {expectedDocVersion (the HEAD's)}
// DRAFT -> READY_FOR_INVOICE; needs the exact `approve_payables` action. This is NOT an approval
// step - it records that the payable's evidence is resolved and PINS the exact immutable version a
// future Invoice will consume. Unresolved Finance items, an empty breakdown or a negative total
// are refused as 409 with per-item blockers.
// The URL's payableRef always wins over anything in the body.
export async function POST(request: Request, { params }: RouteParams) {
  const { payableRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await markPayableReadyForInvoice(actor, { ...(body as object), payableRef }, newRequestId());
  return toFinancePayablesHttpResponse(result);
}
