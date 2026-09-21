import { NextResponse } from "next/server";

import { checkOnboardingDuplicates } from "@/server/finance-agreements";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

// POST /api/finance/onboarding/duplicates {type, displayName, email?, phone?, accounts?[{platform, handle?, profileUrl?, platformAccountId?}]} -
// the possible existing Partners / Vendors for a would-be new one, filtered by the caller's LIVE record scope: visible candidates carry
// {ref, displayName, regions, status, signals, strength}; a strong match the caller cannot see is only the neutral flag
// `strongMatchOutsideYourAccess`. Read-only (POST because the body carries contact details that must not sit in a URL); writes nothing.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  // The audit request id is minted for parity with the other POST routes; a duplicate lookup appends no event.
  void newRequestId();
  const result = await checkOnboardingDuplicates(actor, body);
  return toFinanceAgreementsHttpResponse(result);
}
