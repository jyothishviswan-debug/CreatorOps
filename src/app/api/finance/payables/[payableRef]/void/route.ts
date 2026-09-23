import { NextResponse } from "next/server";

import { voidPayable } from "@/server/finance-payables";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinancePayablesHttpResponse } from "@/server/finance-payables/http";

type RouteParams = { params: Promise<{ payableRef: string }> };

// POST /api/finance/payables/[payableRef]/void {expectedDocVersion (the HEAD's), reason}
// DRAFT | READY_FOR_INVOICE -> VOID; needs the exact `void_payables` action and a reason. Terminal:
// nothing leaves VOID, a voided payable can never be invoiced, and every historical version and
// event is retained. There is no delete.
// The URL's payableRef always wins over anything in the body.
export async function POST(request: Request, { params }: RouteParams) {
  const { payableRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await voidPayable(actor, { ...(body as object), payableRef }, newRequestId());
  return toFinancePayablesHttpResponse(result);
}
