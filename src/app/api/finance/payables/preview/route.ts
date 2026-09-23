import { NextResponse } from "next/server";

import { previewPayableSource } from "@/server/finance-payables";
import { parseJsonBody, resolveRequestActor, toFinancePayablesHttpResponse } from "@/server/finance-payables/http";

// POST /api/finance/payables/preview {counterpartyType, counterpartyRef, commercialPeriod, agreementRef?}
// Resolves the commercial evidence for a basis and runs the determination engine WITHOUT writing
// anything: the pinned Agreement / Review versions, the immutable snapshot that would be captured,
// the amount breakdown, what Finance would still have to confirm, and - when generation is refused
// - the plain-language blockers. Needs manage_payables (a preview reveals the same figures a
// created Payable would). Amounts require the finance_amounts sensitive category.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await previewPayableSource(actor, body);
  return toFinancePayablesHttpResponse(result);
}
