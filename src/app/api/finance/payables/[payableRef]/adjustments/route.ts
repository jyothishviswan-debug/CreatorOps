import { NextResponse } from "next/server";

import { addPayableAdjustment, removePayableAdjustment } from "@/server/finance-payables";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinancePayablesHttpResponse } from "@/server/finance-payables/http";

type RouteParams = { params: Promise<{ payableRef: string }> };

// POST /api/finance/payables/[payableRef]/adjustments
//   {expectedDocVersion (the HEAD's), label, amountMinorSigned, reason, resolvesCode?}
// Adds ONE manual financial adjustment line to a DRAFT payable, as the NEXT immutable version.
// Needs the exact `adjust_payables` action AND the finance_amounts sensitive category, and a
// non-empty reason. Every add is audit-logged and no prior version is ever mutated.
// The URL's payableRef always wins over anything in the body.
export async function POST(request: Request, { params }: RouteParams) {
  const { payableRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await addPayableAdjustment(actor, { ...(body as object), payableRef }, newRequestId());
  return toFinancePayablesHttpResponse(result);
}

// DELETE /api/finance/payables/[payableRef]/adjustments {expectedDocVersion, lineRef, reason}
// Removes ONE manual adjustment line from a DRAFT payable, as the NEXT immutable version (the
// version that carried the line stays readable). Same exact permission as adding one.
export async function DELETE(request: Request, { params }: RouteParams) {
  const { payableRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await removePayableAdjustment(actor, { ...(body as object), payableRef }, newRequestId());
  return toFinancePayablesHttpResponse(result);
}
