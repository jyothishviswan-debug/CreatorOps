import { NextResponse } from "next/server";

import { extractContract } from "@/server/finance-agreements";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";
import { checkRateLimit, requestIpKey } from "@/server/shared/rate-limit";

// Production hardening (base spec section 21 - rate limiting / abuse control): this is the ONE
// route that can trigger real local OCR (extraction-service.ts's own runOcrForAgreement, real
// Tesseract recognition, ~1s+ per page) - exactly the "expensive... endpoint" class base spec
// section 21 names by example. Rate-limited PER ACTOR (an authenticated actor's own uid, never by
// IP, so one compromised/malicious account can't dodge the limit behind a rotating/shared proxy IP)
// before the expensive work ever runs. An unauthenticated caller (no session) is limited by IP
// instead, purely so an anonymous flood can't tie up route/actor resolution itself -
// extractContract's own gate independently rejects it regardless. See
// src/server/shared/rate-limit.ts for the shared abstraction and its own local-only-not-production
// caveat.
// Deliberately generous: existing Playwright coverage (finance-agreements-intake.spec.ts,
// finance-ocr-completion.spec.ts) reuses the SAME fixed seeded "manager" actor across many tests,
// so this must stay well above realistic cumulative test-suite call volume for one actor within one
// window while still being a real, meaningful bound against a scripted abuse loop (60 real OCR
// calls in 5 minutes is still a substantial, deliberately-costed ceiling, not an unlimited tap).
const MAX_EXTRACTIONS_PER_WINDOW = 60;
const EXTRACTION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// POST /api/finance/contracts/extract {agreementRef, version, artifactRef} - parse one uploaded
// contract PDF (local, deterministic) into a recorded extraction run. A preparation step only:
// nothing extracted is attached, confirmed or operational, and no Partner / Vendor / KYC record is
// written. An unreadable / scanned PDF is a MANUAL_REVIEW_REQUIRED result, not an error.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();

  const dimension = actor ? actor.uid : requestIpKey(request);
  const decision = checkRateLimit("finance_contracts_extract", dimension, MAX_EXTRACTIONS_PER_WINDOW, EXTRACTION_WINDOW_MS);
  if (!decision.allowed) {
    return NextResponse.json({ error: "Too many extraction requests. Try again shortly." }, { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } });
  }

  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await extractContract(actor, body, newRequestId());
  return toFinanceAgreementsHttpResponse(result);
}
