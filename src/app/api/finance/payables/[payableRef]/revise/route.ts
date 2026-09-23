import { NextResponse } from "next/server";

import { revisePayable } from "@/server/finance-payables";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinancePayablesHttpResponse } from "@/server/finance-payables/http";

type RouteParams = { params: Promise<{ payableRef: string }> };

// POST /api/finance/payables/[payableRef]/revise {expectedDocVersion (the HEAD's), refreshSource?, reason}
// Appends the NEXT immutable payable version; needs manage_payables. `refreshSource: true` re-pins
// the Agreement / Review versions that govern this period TODAY - the only way a later source
// revision ever reaches a payable, and it never rewrites an earlier version. A payable that was
// READY_FOR_INVOICE returns to DRAFT.
// The URL's payableRef always wins over anything in the body.
export async function POST(request: Request, { params }: RouteParams) {
  const { payableRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await revisePayable(actor, { ...(body as object), payableRef }, newRequestId());
  return toFinancePayablesHttpResponse(result);
}
