import { NextResponse } from "next/server";

import { createPayablesForItems } from "@/server/finance-payables";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinancePayablesHttpResponse } from "@/server/finance-payables/http";

// POST /api/finance/payables/bulk {items: [{counterpartyType, counterpartyRef, commercialPeriod, agreementRef?}]}
// Finding #62: the ONE logical bulk-create request - never a client-side loop of individual
// POST /api/finance/payables calls. Always 200 with a per-item results array
// (created/existing/error) - a single item's failure never fails the whole request with a top-level
// error status, matching /api/assignments/bulk's own established convention.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createPayablesForItems(actor, body, newRequestId());
  if (!result.ok) return toFinancePayablesHttpResponse(result);
  return NextResponse.json(result.data, { status: 200 });
}
