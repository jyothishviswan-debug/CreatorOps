import { NextResponse } from "next/server";

import { confirmPayableTax } from "@/server/finance-payables";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinancePayablesHttpResponse } from "@/server/finance-payables/http";

type RouteParams = { params: Promise<{ payableRef: string }> };

// POST /api/finance/payables/[payableRef]/tax
//   {expectedDocVersion (the HEAD's), gstApplicable, gstRateBps}
// Step 15C.1 section 10: the smallest safe Finance confirmation of GST applicability/rate for a
// DRAFT, Partner-Review-sourced payable. Writes the confirmed value onto the NEXT immutable
// version's own snapshot.tax fields (provenance FINANCE_CONFIRMED) - never a generic manual
// adjustment line. Needs the exact `adjust_payables` action AND the finance_amounts sensitive
// category, same as a manual adjustment. The URL's payableRef always wins over anything in the body.
export async function POST(request: Request, { params }: RouteParams) {
  const { payableRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await confirmPayableTax(actor, { ...(body as object), payableRef }, newRequestId());
  return toFinancePayablesHttpResponse(result);
}
