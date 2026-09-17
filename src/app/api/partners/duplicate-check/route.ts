import { NextResponse } from "next/server";

import { checkForPartnerDuplicates } from "@/server/partners/duplicate-check";
import { parseJsonBody, resolveRequestActor } from "@/server/partners/http";
import { requirePartnersFeatureAccess } from "@/server/partners/partners-gate";

// POST /api/partners/duplicate-check - pre-create, read-only, advisory.
// No Partner exists yet, so nothing is persisted - same idiom as
// Discovery's own pre-create duplicate-check endpoint.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const gate = await requirePartnersFeatureAccess(actor);
  if (!gate.ok) {
    const status = gate.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  const body = await parseJsonBody(request);
  if (body === undefined || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const input = body as Record<string, unknown>;

  const email = typeof input.email === "string" ? input.email : undefined;
  const phone = typeof input.phone === "string" ? input.phone : undefined;
  const originLeadRef = typeof input.originLeadRef === "string" ? input.originLeadRef : undefined;
  const accountIdentity =
    input.accountIdentity && typeof input.accountIdentity === "object"
      ? (input.accountIdentity as { platform?: unknown; platformAccountId?: unknown; profileUrl?: unknown; handle?: unknown })
      : undefined;

  if (!email && !phone && !originLeadRef && !(accountIdentity && typeof accountIdentity.platform === "string")) {
    return NextResponse.json({ error: "At least one of email, phone, accountIdentity, or originLeadRef is required." }, { status: 400 });
  }

  const result = await checkForPartnerDuplicates({
    email,
    phone,
    originLeadRef,
    accountIdentity:
      accountIdentity && typeof accountIdentity.platform === "string"
        ? {
            platform: accountIdentity.platform,
            platformAccountId: typeof accountIdentity.platformAccountId === "string" ? accountIdentity.platformAccountId : undefined,
            profileUrl: typeof accountIdentity.profileUrl === "string" ? accountIdentity.profileUrl : undefined,
            handle: typeof accountIdentity.handle === "string" ? accountIdentity.handle : undefined,
          }
        : undefined,
  });

  return NextResponse.json(result, { status: 200 });
}
