import { NextResponse } from "next/server";

import { previewInvoiceEligibility } from "@/server/finance-invoices";
import { parseJsonBody, resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

// POST /api/finance/invoices/preview {payableRef}
// Resolves a Payable's eligibility to found an Invoice, WITHOUT writing anything: the pin that
// would be captured, whether a canonical Invoice for that Payable already exists, and - when
// generation is refused - the plain-language blockers. Needs manage_invoices + finance_amounts (a
// preview reveals the same pinned figures a created Invoice would).
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await previewInvoiceEligibility(actor, body);
  return toFinanceInvoicesHttpResponse(result);
}
