import { NextResponse } from "next/server";

import { createCounterpartyFromOnboarding, getOnboardingStatus } from "@/server/finance-agreements";
import { newRequestId, optionalStringParam, parseJsonBody, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

// GET /api/finance/onboarding?clientRequestId= (or ?onboardingRef=) - the step ledger of an onboarding the caller started: which steps are
// done, which failed, whether the same request can resume it. Reads only; never resumes or writes.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);

  const result = await getOnboardingStatus(actor, { onboardingRef: optionalStringParam(searchParams, "onboardingRef"), clientRequestId: optionalStringParam(searchParams, "clientRequestId") });
  return toFinanceAgreementsHttpResponse(result);
}

// POST /api/finance/onboarding {clientRequestId, type, reviewedProfile, accounts?, duplicateDecision} - create the Partner / Vendor (and Partner
// Accounts) from a reviewed Agreement through the OWNING services and start the Agreement draft. Idempotent and resumable: the same
// clientRequestId with the same body resumes / replays. 200 with an outcome (COMPLETED | FAILED at a step | IN_PROGRESS); a refusal before anything
// was written is 400 / 403 / 404 / 409 (409 carries `blockers[].code`, e.g. counterparty_create_not_permitted, strong_match_outside_access).
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createCounterpartyFromOnboarding(actor, body, newRequestId());
  return toFinanceAgreementsHttpResponse(result);
}
